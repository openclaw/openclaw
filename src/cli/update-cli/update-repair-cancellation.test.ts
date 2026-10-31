// Register shared mocks before importing the production CLI graph.
import "./update-repair.test-support.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as census from "../../infra/openclaw-process-census.js";
import { mockInertSealedHelper } from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  publicationActivation,
  withPublicationFence,
} from "../../infra/package-update-publication.test-support.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import * as handoffLease from "../../infra/update-managed-service-handoff-lease.js";
import * as legacyHandoffStore from "../../infra/update-managed-service-handoff-legacy-store.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { killPidIfAlive, waitForPidToExit } from "../../test-utils/process-tree.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { updateExecutorNativeEntrypoints as native } from "./update-command-executor-native-runtime.test-support.js";
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
  expect(handoffLease.resolveManagedUpdateLeaseDatabasePath()).toBe(databasePath);
  vi.spyOn(os, "tmpdir").mockReturnValue(privateTmp);
  const binding = createManagedHandoffTestBinding(privateTmp);
  const guardEnv = writePrivateUpdateHandoffChildGuard(databasePath, privateTmp);
  const childEnv = guardEnv({ ...process.env, TMPDIR: privateTmp });
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
  const script = path.join(root, "cancelled-original.mjs");
  const url = (key: keyof typeof native) =>
    JSON.stringify(resolveRuntimeWorkerUrl(native[key]).href);
  const fixture = {
    root,
    install,
    slot,
    databasePath,
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
const executor = await import(${url("executor")});
const { createUpdateRun } = await import(${url("runLedger")});
const { readUpdateRunDriver } = await import(${url("runDriver")});
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
      const result = spawnSync(resolveTestNodeExecPath(), [binding.nodeOption, script], {
        env: childEnv,
        encoding: "utf8",
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      expect([result.error, result.signal], result.stderr).toEqual([undefined, "SIGKILL"]);
      assertManagedHandoffTestConsumer(
        binding,
        result.pid,
        fileURLToPath(new URL("../../", resolveRuntimeWorkerUrl(native.executor))),
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

/** Repair finished its own maintenance and reported the cancelled custody it could not settle. */
async function expectRetainedCustody(
  original: ReturnType<typeof f.crash>["original"],
  reason: string | RegExp,
  nextAction: string | RegExp = "update repair",
) {
  mocks.doctor.mockClear();
  await expect(repair()).rejects.toEqual(new ExitError(2));
  expect(mocks.doctor).toHaveBeenCalled();
  expect(lastJson()).toMatchObject({
    status: "warning",
    nextAction: expect.stringMatching(nextAction),
    retainedUpdateCustody: {
      key: f.install,
      owner: original.owner,
      leaseVersion: 4,
      lastActivityAt: new Date(original.updated_at).toISOString(),
      reason: expect.stringMatching(reason),
    },
  });
}

/** Repair released the whole custody family, recorded its settled keys, and admits the next run. */
async function expectSettledCustody(runId: string, family?: ReturnType<typeof f.rows>) {
  expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  expect(lastJson()).toMatchObject({ status: "ok" });
  expect(lastJson()).not.toHaveProperty("retainedUpdateCustody");
  expect(f.rows()).toEqual([]);
  if (family) {
    const keys = family.map((row) => row.install_root).join(", ");
    expect(
      listUpdateRuns()[0]!.steps.find(({ step }) => step === "finalize:handoff-settlement"),
    ).toMatchObject({
      status: "completed",
      detail: expect.stringContaining(`Settled keys: ${keys}`),
    });
  }
  await expect(admit(runId)).resolves.toBe("admitted");
}

/** An earlier Gateway's handoff store beside the private temp root; admission reads it. */
async function useEarlierGatewayStore(name: string) {
  const databasePath = path.join(f.root, name, "managed-update-handoffs.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { mode: 0o700 });
  vi.spyOn(
    legacyHandoffStore,
    "resolveLegacyGatewayManagedUpdateLeaseDatabasePath",
  ).mockReturnValue(databasePath);
  const store = await handoffLease.prepareManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  return { databasePath, store };
}

unix(
  "repair settles a dead updater's cancelled custody family and admits the next update",
  { timeout: 60_000 },
  async () => {
    const { family, original, runId } = f.crash();
    await expect(admit("blocked-update")).rejects.toThrow(
      `Another update executor owns this installation. It retains cancelled update custody (owner ${original.owner}, lease version 4, last activity ${new Date(original.updated_at).toISOString()})`,
    );

    // A live candidate and then a referencing process each keep the exact family;
    // repair still finishes its own maintenance and reports the blocker.
    await expectRetainedCustody(original, `live or unverified: PID ${f.candidate}`);
    expect(f.rows()).toEqual(family);
    await f.stopCandidate();
    f.censusMatches.push(424242);
    await expectRetainedCustody(original, /PID 424242/);
    expect(f.rows()).toEqual(family);
    expect(f.censusRuns).toEqual([runId]);

    await repair();
    await expectSettledCustody("next-update", family);
    expect(f.rows()).toEqual([]);
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

    // Package settlement used to request fresh admission, which the custody refused.
    await repair();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("closed as publication-not-started"),
    );
    await expectSettledCustody("next-update");
  },
);

unix.each(["failed", "deferred"] as const)(
  "a %s cancelled-custody repair keeps the original evidence and reports it on rerun",
  { timeout: 60_000 },
  async (interruption) => {
    const { original, runId } = f.crash();
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
      // The open claim still guards the cancelled custody; the report says so.
      await expectRetainedCustody(
        original,
        "Doctor maintenance remains pending",
        /gateway stop.*update repair.*Cancelled update custody/su,
      );
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
    await expectRetainedCustody(original, `live or unverified: PID ${process.pid}`);
    expect(f.rows()).toHaveLength(1);
  },
);

unix(
  "an earlier macOS Gateway's cancelled custody fences admission until repair settles it",
  { timeout: 60_000 },
  async () => {
    const { family } = f.crash();
    // The current per-user store is empty; the Gateway's TMPDIR store holds the family.
    const current = path.join(f.root, "current-tmp");
    fs.mkdirSync(current, { mode: 0o700 });
    vi.mocked(temporaryRoot.resolvePreferredOpenClawTmpDir).mockReturnValue(current);
    vi.mocked(handoffLease.resolveManagedUpdateLeaseDatabasePath).mockReturnValue(
      path.join(current, "managed-update-handoffs.sqlite"),
    );
    vi.spyOn(
      legacyHandoffStore,
      "resolveLegacyGatewayManagedUpdateLeaseDatabasePath",
    ).mockReturnValue(f.databasePath);

    // Normal admission reads the shared store, yet the earlier store still fences it.
    await expect(admit("blocked-by-earlier-gateway")).rejects.toThrow(
      `Another update executor owns this installation in an earlier Gateway's handoff store (${f.databasePath})`,
    );
    await f.stopCandidate();
    await repair();
    await expectSettledCustody("after-earlier-gateway-repair", family);
  },
);

unix("a live owner in an earlier macOS Gateway's store keeps admission fenced", async () => {
  // This live process stands in for an earlier Gateway still running its update.
  const { databasePath, store } = await useEarlierGatewayStore("gateway-tmp");
  const held = store.acquire(fs.realpathSync(f.install), "earlier-gateway", { kind: "update" });
  assert(held.kind === "acquired", "Expected the earlier Gateway lease");

  await expect(admit("blocked-by-live-earlier-owner")).rejects.toThrow(
    `Another update executor owns this installation in an earlier Gateway's handoff store (${databasePath})`,
  );
  expect(store.release(held.lease)).toBe(true);
  await expect(admit("after-earlier-owner-release")).resolves.toBe("admitted");
  // Admission releases its fence; the earlier store keeps no row for this installation.
  expect(store.read(fs.realpathSync(f.install))).toMatchObject({ kind: "absent" });
});

unix(
  "an earlier Gateway's original-updater custody fences admission after its owners die",
  async () => {
    const { databasePath } = await useEarlierGatewayStore("gateway-tmp");
    // Original custody waits for its explicit settlement; process death never reclaims it.
    const exitedProcess = () => ({
      pid: Number(
        spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
          encoding: "utf8",
        }).stdout,
      ),
      startIdentity: "1",
    });
    const payload = {
      version: 2,
      helper: exitedProcess(),
      executor: exitedProcess(),
      action: { kind: "update", mutationProtocol: "original-cancellation-v1" },
    };
    createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .insertInto("managed_update_handoffs")
          .values({
            install_root: fs.realpathSync(f.install),
            owner: "earlier-original-updater",
            payload_json: JSON.stringify(payload),
            updated_at: Date.now() - 60 * 60_000,
          }),
      ),
    );

    await expect(admit("blocked-by-earlier-original")).rejects.toThrow(
      `Another update executor owns this installation in an earlier Gateway's handoff store (${databasePath})`,
    );
  },
);
