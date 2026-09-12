import "./doctor-update.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import * as leases from "../infra/update-managed-service-handoff-lease.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runDoctorUpdateChild } from "./doctor-update.executor.test-support.js";

const { installDoctorUpdateTestHooks, mocks, mockGitCheckout, mockUpdateResult, runOffer } =
  await import("./doctor-update.test-support.js");
const actualRun = await vi.importActual<typeof import("../cli/update-cli/update-command-run.js")>(
  "../cli/update-cli/update-command-run.js",
);
const actualMigrated = await vi.importActual<
  typeof import("../cli/update-cli/update-command-migrated.js")
>("../cli/update-cli/update-command-migrated.js");
installDoctorUpdateTestHooks();
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
let root: string;
beforeEach(() => {
  mocks.realLedger = true;
  root = dirs.make("doctor-public-ledger-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_PROFILE", "doctor-test");
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  mocks.admitUpdateCommandRun.mockImplementation(actualRun.admitUpdateCommandRun);
  mocks.completeUpdateCommandRun.mockImplementation(actualRun.completeUpdateCommandRun);
  mocks.failUpdateCommandRun.mockImplementation(actualRun.failUpdateCommandRun);
  mocks.resolveGatewayService.mockReturnValue({ readCommand: async () => null });
  mockGitCheckout(root);
});

describe("Doctor public caller durable outcome", () => {
  it("waits for an outstanding real child before rejecting without terminal history", async () => {
    const ready = createDeferred();
    const returning = createDeferred();
    const proceed = path.join(root, "proceed-outstanding");
    let child: Promise<unknown> | undefined;
    mocks.runGatewayUpdate.mockImplementation(async ({ beforeGitMutation }) => {
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      await beforeGitMutation({});
      child = runDoctorUpdateChild(
        run,
        `process.stdout.write("ready\\n"); while(!fs.existsSync(payload.proceed)) await setTimeout(10); fence.assertCurrent();`,
        { proceed },
        (text) => {
          if (text.includes("ready")) {
            ready.resolve();
          }
        },
      );
      void child.catch(() => undefined);
      await ready.promise;
      returning.resolve();
      return { status: "ok", mode: "git", root, steps: [], durationMs: 1 };
    });
    let ended = false;
    const offer = runOffer({ root, confirm: vi.fn().mockResolvedValue(true) });
    const settled = offer.then(
      (value) => {
        ended = true;
        return { value };
      },
      (error: unknown) => {
        ended = true;
        return { error };
      },
    );
    try {
      await Promise.race([
        returning.promise,
        settled.then(() => {
          throw new Error("Offer ended before outstanding child");
        }),
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      expect(ended).toBe(false);
      expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
      expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.triageCommand).not.toHaveBeenCalled();
      expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Update result");
    } finally {
      fs.writeFileSync(proceed, "go");
    }
    const outcome = await settled;
    await child;
    expect(outcome).toMatchObject({ error: expect.any(Error) });
    const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
    expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.triageCommand).not.toHaveBeenCalled();
    expect(leases.createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
  });

  it("records a non-Error operation rejection after real executor release", async () => {
    mocks.runGatewayUpdate.mockRejectedValue("candidate preflight refused");
    mocks.failUpdateCommandRun.mockImplementation((error, run) => {
      expect(leases.createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
      return actualRun.failUpdateCommandRun(error, run);
    });
    await expect(
      runOffer({ root, confirm: vi.fn().mockResolvedValue(true) }),
    ).rejects.toMatchObject({
      cause: "candidate preflight refused",
    });
    const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
    expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
      status: "failed",
      reason: "update-failed",
    });
    expect(mocks.failUpdateCommandRun).toHaveBeenCalledOnce();
    expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.triageCommand).not.toHaveBeenCalled();
  });

  it.each([
    { status: "ok", refuseRelease: false },
    { status: "error", refuseRelease: false },
    { status: "ok", refuseRelease: true },
  ] as const)(
    "publishes $status only after real child and root release, refusal=$refuseRelease",
    async ({ status, refuseRelease }) => {
      const ready = createDeferred();
      const proceed = path.join(root, "proceed");
      const originalCreate = leases.createManagedHandoffLeaseStore;
      let sawRelease = false;
      vi.spyOn(leases, "createManagedHandoffLeaseStore").mockImplementation((...args) => {
        const store = originalCreate(...args);
        const release = store.release;
        return {
          ...store,
          release(lease) {
            if (lease.key === root) {
              const run = mocks.admitUpdateCommandRun.mock.results[0]?.value;
              // Admission resolves before the child starts; read the captured same run below.
              expect(run).toBeDefined();
              expect(getUpdateRun(admitted!.runId, { env: admitted!.env })?.status).toBe("running");
              sawRelease = true;
              if (refuseRelease) {
                return false;
              }
            }
            return release(lease);
          },
        };
      });
      let admitted: Awaited<ReturnType<typeof actualRun.admitUpdateCommandRun>> | undefined;
      mocks.runGatewayUpdate.mockImplementation(async ({ beforeGitMutation }) => {
        admitted = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
        if (!admitted) {
          throw new Error("Doctor fixture did not capture its admitted run");
        }
        await beforeGitMutation({});
        await runDoctorUpdateChild(
          admitted,
          `process.stdout.write("ready\\n"); while(!fs.existsSync(payload.proceed)) await setTimeout(10); fence.assertCurrent();`,
          { proceed },
          (text) => {
            if (text.includes("ready")) {
              ready.resolve();
            }
          },
        );
        return {
          status,
          mode: "git",
          root,
          after: { version: "2026.4.24" },
          reason: status === "error" ? "candidate-failed" : undefined,
          recovery: { serviceRestartSafe: true, version: "2026.4.24" },
          steps: [],
          durationMs: 1,
        };
      });
      mocks.triageCommand.mockImplementation(async () => {
        expect(sawRelease).toBe(true);
        expect(getUpdateRun(admitted!.runId, { env: admitted!.env })?.status).toBe("failed");
      });
      const offer = runOffer({ root, confirm: vi.fn().mockResolvedValue(true) });
      const settled = offer.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          ready.promise,
          settled.then(() => {
            throw new Error("Offer ended before child admission");
          }),
        ]);
        expect(getUpdateRun(admitted!.runId, { env: admitted!.env })?.status).toBe("running");
        expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
        expect(mocks.triageCommand).not.toHaveBeenCalled();
        expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Update result");
        expect(originalCreate().acquire(root, "competitor", { kind: "update" }).kind).toBe("busy");
      } finally {
        fs.writeFileSync(proceed, "go");
      }
      const outcome = await settled;
      expect(sawRelease).toBe(true);
      if (refuseRelease) {
        expect(outcome).toMatchObject({ error: expect.any(Error) });
        expect(getUpdateRun(admitted!.runId, { env: admitted!.env })?.status).toBe("running");
        expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
        expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
        expect(mocks.triageCommand).not.toHaveBeenCalled();
        return;
      }
      if (status === "error") {
        expect(outcome).toEqual({ error: new ExitError(1) });
      } else {
        expect(outcome).toEqual({ value: { updated: true, handled: true } });
      }
      const terminal = getUpdateRun(admitted!.runId, { env: admitted!.env });
      expect(terminal).toMatchObject({
        status: status === "ok" ? "succeeded" : "failed",
        after: { version: "2026.4.24" },
      });
      expect(terminal?.finishedAtMs).toEqual(expect.any(Number));
      expect(mocks.completeUpdateCommandRun).toHaveBeenCalledOnce();
      expect(originalCreate().read(root).kind).toBe("absent");
    },
  );

  it.each(["terminal-failure", "lost-response"] as const)(
    "leaves the actual migrated ledger with its registered candidate: %s",
    async (fault) => {
      mockUpdateResult({ status: "ok", mode: "git", root, after: { version: "2026.4.24" } });
      mocks.inspectActivatedUpdateState.mockResolvedValue("state-migrated-no-rollback");
      mocks.continueMigratedUpdateInFreshProcess.mockImplementation(
        actualMigrated.continueMigratedUpdateInFreshProcess,
      );
      const worker = path.join(
        root,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      );
      fs.mkdirSync(path.dirname(worker), { recursive: true });
      const receipt = path.join(root, "candidate-ledger.json");
      fs.writeFileSync(
        worker,
        `
      // Source-only worker fixture: resolve workspace aliases without changing cwd/root.
      process.env.TSX_TSCONFIG_PATH=${JSON.stringify(path.resolve("tsconfig.json"))};
      await import(${JSON.stringify(new URL("../../scripts/tsx.mjs", import.meta.url).href)});
      if(process.argv.includes("--check")) { process.stdout.write(JSON.stringify({executorDelegation:"pid-start-v1"})); }
      else {
        const fs=await import("node:fs");
        const {withDelegatedUpdateCommandExecutor}=await import(${JSON.stringify(new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href)});
        const {adoptUpdateRun,finishUpdateRun,getUpdateRun}=await import(${JSON.stringify(new URL("../infra/update-run-ledger.ts", import.meta.url).href)});
        const input=JSON.parse(fs.readFileSync(0,"utf8")); const run=input.params.opts.run;
        await withDelegatedUpdateCommandExecutor(input.executor,run.runId,input.params.root,async fence=>{
          fence.assertCurrent(); adoptUpdateRun(run.runId,{env:run.env});
          fence.assertCurrent(); finishUpdateRun(run.runId,{status:"failed",reason:"candidate-terminal",after:{version:"2026.4.24"}},{env:run.env});
          const row=getUpdateRun(run.runId,{env:run.env}); fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(row));
          if(${JSON.stringify(fault)}!=="lost-response") fs.writeFileSync(input.resultPath,JSON.stringify({executorDelegation:"pid-start-v1",terminalRunId:run.runId,result:{...input.params.result,status:"error",reason:"candidate-terminal",runId:run.runId},exitCode:1}));
        });
      }
    `,
      );
      await expect(runOffer({ root, confirm: vi.fn().mockResolvedValue(true) })).rejects.toThrow();
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      const candidate = JSON.parse(fs.readFileSync(receipt, "utf8"));
      expect(candidate).toMatchObject({
        runId: run.runId,
        status: "failed",
        reason: "candidate-terminal",
      });
      expect(getUpdateRun(run.runId, { env: run.env })).toEqual(candidate);
      expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.triageCommand).not.toHaveBeenCalled();
      expect(leases.createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
    },
  );
});
