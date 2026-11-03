// Register shared mocks before importing the production CLI graph.
import "./update-repair.test-support.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../../test/helpers/managed-handoff-isolation.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../../test/helpers/private-update-handoff-store.js";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as census from "../../infra/openclaw-process-census.js";
import { mockInertSealedHelper } from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  publicationActivation,
  withPublicationFence,
} from "../../infra/package-update-publication.test-support.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { killPidIfAlive, waitForPidToExit } from "../../test-utils/process-tree.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { preparePackagePublication } from "./update-package-publication.test-support.js";

const { createRepairState, mocks } = await import("./update-repair.test-support.js");

vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
}));

// Bound candidate process groups and SIGKILL are POSIX custody facts.
const unix = process.platform === "win32" ? it.skip : it;
let state: OpenClawTestState;
let f: ReturnType<typeof createCrashFixture>;

beforeEach(async () => {
  state = await createRepairState("repair-cancellation", {
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    OPENCLAW_UPDATE_POST_CORE: undefined,
  });
  f = createCrashFixture(fs.realpathSync(state.root));
});
afterEach(async () => {
  killPidIfAlive(f.candidate);
  vi.restoreAllMocks();
  await state.cleanup();
});

/** A real original executor binds a candidate, cancels, and dies by SIGKILL. */
function createCrashFixture(root: string) {
  const install = path.join(root, "install");
  fs.mkdirSync(install, { mode: 0o700 });
  writeJsonFile(path.join(install, "package.json"), { name: "openclaw", version: "1.0.0" });
  // Repair is invoked through the occupied-slot spelling admission canonicalizes.
  const slot = path.join(root, "linked-install");
  fs.symlinkSync(install, slot, "dir");
  mocks.root.mockResolvedValue(slot);
  const privateTmp = path.join(root, "private-tmp");
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  const { databasePath } = installPrivateUpdateHandoffStore(privateTmp);
  expect(resolveManagedUpdateLeaseDatabasePath()).toBe(databasePath);
  vi.spyOn(os, "tmpdir").mockReturnValue(privateTmp);
  const binding = createManagedHandoffTestBinding(privateTmp);
  const childEnv = writePrivateUpdateHandoffChildGuard(
    databasePath,
    privateTmp,
  )({
    ...process.env,
    TMPDIR: privateTmp,
  });
  // Host census is the only synthetic observation; process and SQLite custody stay real.
  const censusRuns: string[] = [];
  const censusMatches: number[] = [];
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockImplementation(((references?: {
    runId: string;
  }) => {
    if (typeof references !== "object") {
      return { pids: [] };
    }
    censusRuns.push(references.runId);
    return { matchingPids: censusMatches.splice(0), unverifiedPids: [] };
  }) as typeof census.inspectOtherOpenClawProcesses);
  const rows = () =>
    createManagedHandoffLeaseDatabase(databasePath)(false, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().orderBy("install_root"),
      ),
    ).rows;
  const pidFile = path.join(root, "candidate.pid");
  const script = path.join(root, "cancelled-original.mts");
  const url = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  const fixture = {
    install,
    slot,
    candidate: undefined as number | undefined,
    censusRuns,
    censusMatches,
    rows,
    /** The orphan's clock starts in the past so explicit repair's grace has elapsed. */
    crash() {
      fs.writeFileSync(
        script,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
createRequire(import.meta.url)(${JSON.stringify(path.join(privateTmp, "private-handoff-guard.cjs"))});
const now = Date.now;
Date.now = () => now() - 50 * 60_000;
const executor = await import(${url("./update-command-executor.ts")});
const { createUpdateRun } = await import(${url("../../infra/update-run-ledger.ts")});
const { readUpdateRunDriver } = await import(${url("../../infra/update-run-driver.ts")});
const run = createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver(), admission: { owner: "installed" } } });
await executor.withUpdateCommandExecutor(run.runId, async (owner) => {
  const fence = await owner.enter(${JSON.stringify(slot)});
  await executor.withUpdateCommandExecutorChild(fence, ${JSON.stringify(slot)}, async (_grant, bindChild) => {
    const candidate = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    bindChild(candidate.pid);
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(candidate.pid));
    executor.requestUpdateCommandExecutorCancellation(fence, run.runId, new Error("activation deadline"));
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  });
});
`,
      );
      const result = spawnSync(
        resolveTestNodeExecPath(),
        ["--import", "tsx", binding.nodeOption, script],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: childEnv,
          encoding: "utf8",
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
      );
      expect([result.error, result.signal], result.stderr).toEqual([undefined, "SIGKILL"]);
      assertManagedHandoffTestConsumer(
        binding,
        result.pid,
        fileURLToPath(new URL("../../", import.meta.url)),
      );
      fixture.candidate = Number(fs.readFileSync(pidFile, "utf8"));
      const family = rows();
      const original = family[0];
      assert(original?.install_root === install, "Missing cancelled original");
      expect(JSON.parse(original.payload_json)).toMatchObject({ version: 4 });
      // The original, its occupied-slot mirror, and the candidate lineage under both roots.
      const lineage = String.raw`/\.openclaw-update-child-[a-f0-9-]{36}-lineage-[a-f0-9]{64}$`;
      expect(family.map((row) => row.install_root)).toEqual([
        install,
        expect.stringMatching(new RegExp(`^${install}${lineage}`)),
        slot,
        expect.stringMatching(new RegExp(`^${slot}${lineage}`)),
      ]);
      const runs = listUpdateRuns();
      expect(runs).toHaveLength(1);
      return { family, original, runId: runs[0]!.runId };
    },
    async stopCandidate() {
      killPidIfAlive(fixture.candidate);
      expect(await waitForPidToExit(fixture.candidate!, 10_000)).toBe(true);
    },
  };
  return fixture;
}

function repair() {
  return withCliProcessScope(() =>
    runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
    }),
  );
}

function admit(runId: string) {
  return withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(f.slot);
    fence.assertCurrent();
    return "admitted";
  });
}

function lastJson() {
  return vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
}

unix(
  "repair settles a dead updater's cancelled custody family and admits the next update",
  { timeout: 60_000 },
  async () => {
    const { family, original, runId } = f.crash();
    const lastActivityAt = new Date(original.updated_at).toISOString();
    await expect(admit("blocked-update")).rejects.toThrow(
      `Another update executor owns this installation. It retains cancelled update custody (owner ${original.owner}, lease version 4, last activity ${lastActivityAt})`,
    );

    // A live candidate and then a referencing process each keep the exact family;
    // repair still finishes its own maintenance and reports the blocker.
    const refusals: [() => Promise<void> | void, string | RegExp][] = [
      [() => undefined, `live or unverified: PID ${f.candidate}`],
      [
        async () => {
          await f.stopCandidate();
          f.censusMatches.push(424242);
        },
        /PID 424242/,
      ],
    ];
    for (const [prepare, reason] of refusals) {
      await prepare();
      vi.mocked(defaultRuntime.writeJson).mockClear();
      mocks.doctor.mockClear();
      await expect(repair()).rejects.toEqual(new ExitError(2));
      expect(mocks.doctor).toHaveBeenCalled();
      expect(lastJson()).toMatchObject({
        status: "warning",
        nextAction: expect.stringContaining("update repair"),
        retainedUpdateCustody: {
          key: f.install,
          owner: original.owner,
          leaseVersion: 4,
          lastActivityAt,
          reason: expect.stringMatching(reason),
        },
      });
      expect(f.rows()).toEqual(family);
    }
    expect(f.censusRuns).toEqual([runId]);

    vi.mocked(defaultRuntime.writeJson).mockClear();
    await repair();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(lastJson()).toMatchObject({ status: "ok" });
    expect(lastJson()).not.toHaveProperty("retainedUpdateCustody");
    expect(f.rows()).toEqual([]);
    expect(
      listUpdateRuns()[0]!.steps.find(({ step }) => step === "finalize:handoff-settlement"),
    ).toMatchObject({
      status: "completed",
      detail: expect.stringContaining(
        `Settled keys: ${family.map((row) => row.install_root).join(", ")}`,
      ),
    });
    await expect(admit("next-update")).resolves.toBe("admitted");
    expect(f.rows()).toEqual([]);
  },
);

unix.each(["failed", "deferred"] as const)(
  "a %s cancelled-custody repair keeps the original evidence and reports it on rerun",
  { timeout: 60_000 },
  async (interruption) => {
    const { original, runId } = f.crash();
    const lastActivityAt = new Date(original.updated_at).toISOString();
    await f.stopCandidate();
    if (interruption === "failed") {
      mocks.doctor.mockRejectedValueOnce(new Error("Doctor interrupted"));
      await repair();
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    } else {
      mocks.doctor.mockRejectedValueOnce(
        new DoctorMaintenanceRefusalError("Synthetic maintenance contention", {
          kind: "deferred",
          reason: "coordinator-contention",
        }),
      );
      await expect(repair()).rejects.toEqual(new ExitError(2));
      // The open claim still guards the cancelled custody; the report says so.
      expect(lastJson()).toMatchObject({
        status: "warning",
        nextAction: expect.stringMatching(
          /gateway stop.*update repair.*Cancelled update custody/su,
        ),
        retainedUpdateCustody: {
          key: f.install,
          owner: original.owner,
          leaseVersion: 4,
          lastActivityAt,
          reason: expect.stringContaining("Doctor maintenance remains pending"),
        },
      });
    }
    const [claim, ...others] = f.rows();
    expect(others).toEqual([]);
    expect(claim).toMatchObject({ install_root: f.install });
    expect(JSON.parse(claim!.payload_json)).toMatchObject({
      action: { kind: "triage", phase: "uncertain" },
    });
    expect(JSON.parse(claim!.recovery_json!)).toMatchObject({
      source: {
        owner: original.owner,
        payload_json: original.payload_json,
        updated_at: original.updated_at,
      },
      facts: { runIds: [runId, listUpdateRuns()[0]!.runId] },
    });
    await expect(admit("blocked-after-interruption")).rejects.toThrow(
      "Another update executor owns this installation",
    );

    // An immediate rerun still finishes maintenance and reports the retained custody.
    // This process owns the interrupted claim, so it stays live and is refused.
    vi.mocked(defaultRuntime.writeJson).mockClear();
    mocks.doctor.mockClear();
    await expect(repair()).rejects.toEqual(new ExitError(2));
    expect(mocks.doctor).toHaveBeenCalled();
    expect(lastJson()).toMatchObject({
      status: "warning",
      retainedUpdateCustody: {
        key: f.install,
        owner: original.owner,
        leaseVersion: 4,
        lastActivityAt,
        reason: expect.stringContaining(`live or unverified: PID ${process.pid}`),
      },
    });
    expect(f.rows()).toHaveLength(1);
  },
);

unix(
  "repair settles cancelled custody together with an unused package preparation",
  { timeout: 60_000 },
  async () => {
    const swap = await createPackageSwapFixture(path.dirname(f.install));
    fs.rmSync(f.install, { recursive: true });
    fs.renameSync(swap.packageRoot, f.install);
    mockInertSealedHelper(path.dirname(f.install));
    await withPublicationFence(f.slot, async (fence) =>
      preparePackagePublication({ ...swap, packageRoot: f.install }, publicationActivation(fence)),
    );
    f.crash();
    await f.stopCandidate();
    await repair();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("closed as publication-not-started"),
    );
    expect(lastJson()).toMatchObject({ status: "ok" });
    expect(f.rows()).toEqual([]);
    await expect(admit("next-update")).resolves.toBe("admitted");
  },
);

unix(
  "a restarted repair resumes a killed repair process but refuses its live claim",
  { timeout: 60_000 },
  async () => {
    const { original } = f.crash();
    await f.stopCandidate();
    const privateTmp = path.join(fs.realpathSync(state.root), "private-tmp");
    const binding = createManagedHandoffTestBinding(privateTmp);
    const ready = path.join(state.root, "repair-ready");
    const script = path.join(state.root, "interrupted-repair.mts");
    const url = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'import { mock } from "node:test";',
        'import { createRequire } from "node:module";',
        "createRequire(import.meta.url)(" +
          JSON.stringify(path.join(privateTmp, "private-handoff-guard.cjs")) +
          ");",
        "const censusUrl = " + url("../../infra/openclaw-process-census.ts") + ";",
        "const census = await import(censusUrl);",
        // Only host census is synthetic; the claim, process identity and recovery metadata are real.
        "mock.module(censusUrl, { namedExports: { ...census, inspectOtherOpenClawProcesses: () => ({ matchingPids: [], unverifiedPids: [] }) } });",
        "const { createManagedHandoffLeaseStore } = await import(" +
          url("../../infra/update-managed-service-handoff-lease.ts") +
          ");",
        "const store = createManagedHandoffLeaseStore({ databasePath: " +
          JSON.stringify(resolveManagedUpdateLeaseDatabasePath()) +
          ", serviceManagerEnv: {} });",
        "const repair = await store.prepareRepair(" + JSON.stringify(f.install) + ", process.env);",
        'if (!repair) throw new Error("Missing cancelled-custody repair");',
        // Interrupt after the custody claim, before finalization admits a new run.
        "fs.writeFileSync(" + JSON.stringify(ready) + ', "ready");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const child = spawn(
      resolveTestNodeExecPath(),
      ["--experimental-test-module-mocks", "--import", "tsx", binding.nodeOption, script],
      {
        env: { ...process.env, TMPDIR: privateTmp, XDG_CACHE_HOME: path.join(state.root, "cache") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    try {
      await vi.waitFor(
        () => {
          assert(child.exitCode === null, output);
          assert(fs.existsSync(ready), output);
        },
        { timeout: 20_000 },
      );
      const [claim] = f.rows();
      expect(JSON.parse(claim!.payload_json)).toMatchObject({
        version: 2,
        helper: { pid: child.pid },
        action: { kind: "triage", phase: "running" },
      });
      await expect(repair()).rejects.toEqual(new ExitError(2));
      expect(f.rows()).toEqual([claim]);
      expect(lastJson()).toMatchObject({
        retainedUpdateCustody: {
          owner: original.owner,
          reason: expect.stringContaining("PID " + child.pid),
        },
      });
      child.kill("SIGKILL");
      expect(await waitForPidToExit(child.pid!, 10_000)).toBe(true);
      await repair();
      expect(lastJson()).toMatchObject({ status: "ok" });
      expect(f.rows()).toEqual([]);
      await expect(admit("next-update")).resolves.toBe("admitted");
    } finally {
      child.kill("SIGKILL");
      await waitForPidToExit(child.pid!, 10_000);
    }
  },
);
