// Register shared mocks before importing the production CLI graph.
import "./update-repair.test-support.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as processIdentity from "@openclaw/proc-safe/identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { mockInertSealedHelper } from "../../infra/package-update-activation-lifetime.test-support.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as legacyHandoffStore from "../../infra/update-managed-service-handoff-legacy-store.js";
import { createManagedHandoffRecoveryFixture } from "../../infra/update-managed-service-handoff-recovery.test-support.js";
import * as handoffScope from "../../infra/update-managed-service-handoff-scope.js";
import {
  createUpdateRun,
  finishUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import * as childTree from "../../process/child-process-tree.js";
import { defaultRuntime } from "../../runtime.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createInterruptedPackagePublication } from "./update-package-publication.test-support.js";

const { createRepairState, mocks } = await import("./update-repair.test-support.js");

// Keep native identity real except for the explicit uninspectable-owner case.
vi.mock("@openclaw/proc-safe/identity", async (original) => ({
  ...(await original<typeof import("@openclaw/proc-safe/identity")>()),
}));

vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
}));
let state: OpenClawTestState;
let fixture: ReturnType<typeof createManagedHandoffRecoveryFixture>;

function repair(flags = ["--yes", "--json", "--timeout", "15"]) {
  return withCliProcessScope(() =>
    runRegisteredCli({ register: registerUpdateCli, argv: ["update", "repair", ...flags] }),
  );
}

function handoffDatabase() {
  return createManagedHandoffLeaseDatabase(
    state.path("handoff-control/managed-update-handoffs.sqlite"),
  );
}

function legacyPayload(helper: typeof fixture.helper, executor = helper) {
  return JSON.stringify({ version: 2, executor, helper, action: { kind: "update" } });
}

function expectAbsent(...roots: string[]) {
  roots.forEach((root) => expect(fixture.store.read(root)).toEqual({ kind: "absent" }));
}

function expectSettlement(detail: string) {
  const run = listUpdateRuns()[0]!;
  expect(run.status).toBe("succeeded");
  expect(run.steps.find(({ step }) => step === "finalize:handoff-settlement")).toMatchObject({
    status: "completed",
    detail: expect.stringContaining(detail),
  });
}

async function expectAdmitted(owner: string) {
  await expect(
    withUpdateCommandExecutor(owner, async (executor) => {
      const fence = await executor.enter(state.root);
      fence.assertCurrent();
      return "admitted";
    }),
  ).resolves.toBe("admitted");
}

beforeEach(async () => {
  state = await createRepairState("repair-handoff", {
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    OPENCLAW_UPDATE_POST_CORE: undefined,
  });
  fixture = createManagedHandoffRecoveryFixture(state.root);
  writeJsonFile(state.path("package.json"), { name: "openclaw", version: "1.0.0" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

it("does not reclaim a handoff from a programmatic call without CLI process ownership", async () => {
  const retained = fixture.seed();
  await runRegisteredCli({
    register: registerUpdateCli,
    argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
  });
  expect(fixture.current()).toEqual(retained);
  expect(
    listUpdateRuns()[0]?.steps.some((step) => step.step === "finalize:handoff-settlement"),
  ).toBe(false);
});

it("registered update repair leaves a live current root owner alone", async () => {
  const acquired = fixture.store.acquire(state.root, "current-update", { kind: "update" });
  expect(acquired.kind).toBe("acquired");
  const retained = fixture.store.read(state.root);

  await repair(["--yes", "--no-restart", "--json"]);

  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
  expect(fixture.store.read(state.root)).toEqual(retained);
});

it.each([
  ["foreground", "dead"],
  ["native", "dead"],
  ["foreground", "live helper"],
  ["native", "live executor"],
  ["foreground", "unknown helper"],
  ["native", "unverified scope"],
] as const)("repair settles or reports a closing %s lease with %s", async (lifetime, owners) => {
  const previous = fixture.seed();
  const nativeScope = handoffScope.createManagedHandoffScopeReader({});
  vi.spyOn(handoffScope, "createManagedHandoffScopeReader").mockReturnValue({
    ...nativeScope,
    nativeClosed: () => owners !== "unverified scope",
  });
  handoffDatabase()(true, (db) =>
    executeSqliteQuerySync(
      db,
      leaseQueries(db)
        .updateTable("managed_update_handoffs")
        .set({
          payload_json: JSON.stringify({
            version: 2,
            helper: previous.helper,
            executor: previous.executor,
            action: {
              kind: "triage",
              phase: "closing",
              lifetime:
                lifetime === "foreground"
                  ? { kind: "foreground", boot: fixture.store.bootIdentity() }
                  : {
                      kind: "native",
                      unit: "openclaw-gateway.service",
                      scope: "triage.scope",
                      placement: { kind: "attached", invocation: "a".repeat(32) },
                    },
            },
          }),
        }),
    ),
  );
  if (owners === "live executor") {
    fixture.births.set(previous.executor.pid, Number(previous.executor.startIdentity));
  } else if (owners === "live helper" || owners === "unknown helper") {
    fixture.births.set(
      previous.helper.pid,
      owners === "live helper" ? Number(previous.helper.startIdentity) : null,
    );
  }
  const retained = fixture.rows();
  await repair();
  if (owners === "dead") {
    expectAbsent(state.root);
    expectSettlement("legacy handoff lease reclaimed");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Warning: Reclaiming"),
    );
    await expectAdmitted("after-closing-repair");
  } else {
    expect(fixture.rows()).toEqual(retained);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining(`owner ${previous.owner}, lease version 2, phase closing`),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(mocks.doctor).not.toHaveBeenCalled();
  }
});

function seedLegacyLineage(nested = false, bound = false) {
  const previous = fixture.seed({ ageMs: 13 * 60 * 60_000 });
  const key = `${state.root}/.openclaw-update-child-01234567-89ab-cdef-0123-456789abcdef-lineage-${"a".repeat(64)}`;
  handoffDatabase()(true, (db) =>
    executeSqliteQuerySync(
      db,
      leaseQueries(db)
        .updateTable("managed_update_handoffs")
        .set({
          install_root: key,
          payload_json: legacyPayload(previous.helper, bound ? previous.executor : previous.helper),
        })
        .where("install_root", "=", state.root),
    ),
  );
  if (nested) {
    const retained = fixture.store.read(key);
    if (retained.kind !== "current") {
      throw new Error("Missing lineage fixture");
    }
    fixture.insert([
      {
        install_root: `${key}/.openclaw-update-child-nested`,
        owner: retained.lease.owner,
        payload_json: retained.lease.payload,
        updated_at: retained.lease.updatedAt,
      },
    ]);
  }
  // An unbound legacy reservation never had a detached executor. An unrelated group
  // or an EPERM group probe must not turn its dead identity into live custody.
  vi.spyOn(childTree, "isChildProcessTreeAlive").mockReturnValue(true);
  fixture.repairFacts.mockRestore();
  vi.spyOn(os, "tmpdir").mockReturnValue(state.root);
  const original = createUpdateRun({
    trigger: "cli",
    origin: { driver: { ...previous.helper, host: os.hostname() } },
  });
  finishUpdateRun(original.runId, { status: "failed", reason: "update-failed" });
  return key;
}

it.each(["root", "dead", "reused", "nested"] as const)(
  "repair reclaims a %s handoff owner and admits the next update",
  async (identity) => {
    const root = identity === "root";
    const key = root ? state.root : seedLegacyLineage(identity === "nested");
    if (root) {
      fixture.seed();
      mocks.doctor.mockImplementation(async () => {
        expect(fixture.readMetadata(fixture.current())?.facts.runIds).toEqual([
          "retained-update",
          listUpdateRuns()[0]?.runId,
        ]);
      });
      await expect(
        withUpdateCommandExecutor("blocked-before-repair", async (executor) => {
          await executor.enter(state.root);
        }),
      ).rejects.toThrow("Another update executor owns this installation");
    }
    if (identity === "reused") {
      fixture.births.set(fixture.helper.pid, 99);
    }
    await repair();
    expectAbsent(key, `${key}/.openclaw-update-child-nested`);
    if (root) {
      expect(listUpdateRuns()).toHaveLength(1);
    }
    expectSettlement(root ? "legacy handoff lease reclaimed" : key);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" }),
    );
    await expectAdmitted("after-lineage-repair");
  },
);

// Process-group survival is POSIX-only; Windows children have no detached group to inspect.
const preservedOwnerCases: readonly ("live" | "uninspectable" | "EPERM" | "surviving group")[] =
  process.platform === "win32"
    ? ["live", "uninspectable", "EPERM"]
    : ["live", "uninspectable", "EPERM", "surviving group"];

it.each(preservedOwnerCases)(
  "repair preserves a %s child-lineage owner with actionable guidance",
  async (identity) => {
    const key = seedLegacyLineage(false, identity === "surviving group");
    if (identity !== "surviving group") {
      fixture.births.set(
        fixture.helper.pid,
        identity === "live" ? Number(fixture.helper.startIdentity) : null,
      );
    }
    if (identity === "EPERM") {
      vi.mocked(pidAlive.isPidDefinitelyDead).mockRestore();
      const readIdentity = processIdentity.readProcessIdentity;
      // Windows also consults native identity after EPERM. The synthetic owner
      // must be uninspectable there too, rather than authoritatively absent.
      vi.spyOn(processIdentity, "readProcessIdentity").mockImplementation((pid) => {
        if (pid === fixture.helper.pid) {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return readIdentity(pid);
      });
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === fixture.helper.pid) {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
    }
    const retained = fixture.store.read(key);
    await repair();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringMatching(
        identity === "surviving group"
          ? /descendants remain live or unverified.*update repair/
          : /live or unverified.*PID.*process-inspection permissions.*update repair/,
      ),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(fixture.store.read(key)).toEqual(retained);
    expect(mocks.doctor).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "checks every retained child's recovery history (pending rollback: %s)",
  async (pendingRollback) => {
    const first = seedLegacyLineage();
    const second = `${state.root}/.openclaw-update-child-z-other-run`;
    const identity = { pid: 1_000_003, startIdentity: "13" };
    const run = createUpdateRun({
      trigger: "cli",
      origin: { driver: { ...identity, host: os.hostname() } },
    });
    if (pendingRollback) {
      recordUpdateRunStep(run.runId, { step: "package rollback", status: "in_progress" });
    }
    finishUpdateRun(run.runId, { status: "failed", reason: "update-failed" });
    fixture.insert([
      {
        install_root: second,
        owner: run.runId,
        payload_json: legacyPayload(identity),
        updated_at: Date.now() - 13 * 60 * 60_000,
      },
    ]);
    const retained = [fixture.store.read(first), fixture.store.read(second)];
    if (!pendingRollback) {
      mocks.doctor.mockImplementation(async () => {
        expect(fixture.readMetadata(fixture.current())?.facts.runIds).toEqual(
          expect.arrayContaining([run.runId]),
        );
      });
    }
    await repair();
    if (pendingRollback) {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("unverified rollback"),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect([fixture.store.read(first), fixture.store.read(second)]).toEqual(retained);
      expectAbsent(state.root);
      expect(mocks.doctor).not.toHaveBeenCalled();
    } else {
      expectAbsent(first, second);
      expect(listUpdateRuns()[0]?.status).toBe("succeeded");
    }
  },
);

it.skipIf(process.platform === "win32").each(["dead", "live"] as const)(
  "repair checks the journal-pinned store with a %s uncertain triage owner and an empty default store",
  async (owner) => {
    mockInertSealedHelper(state.root);
    const publication = await createInterruptedPackagePublication(
      state.path("publication"),
      "publication-complete",
    );
    const { packageRoot, record, anchor } = publication;
    mocks.root.mockResolvedValue(packageRoot);
    const previous = fixture.seed();
    handoffDatabase()(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set({ install_root: packageRoot })
          .where("install_root", "=", state.root),
      ),
    );
    // Use real history discovery and recovery checks, with bounded host observations.
    fixture.repairFacts.mockRestore();
    vi.spyOn(os, "tmpdir").mockReturnValue(state.root);
    const run = createUpdateRun({
      trigger: "cli",
      origin: { driver: { ...previous.helper, host: os.hostname() } },
    });
    finishUpdateRun(run.runId, { status: "failed", reason: "update-failed" });
    if (owner === "live") {
      fixture.births.set(previous.helper.pid, Number(previous.helper.startIdentity));
    }
    const rows = fixture.rows();
    const currentDirectory = state.path("current-handoff");
    fs.mkdirSync(currentDirectory, { mode: 0o700 });
    vi.mocked(temporaryRoot.resolvePreferredOpenClawTmpDir).mockReturnValue(currentDirectory);
    vi.spyOn(
      legacyHandoffStore,
      "resolveLegacyGatewayManagedUpdateLeaseDatabasePath",
    ).mockReturnValue(undefined);
    const currentDatabasePath = path.join(currentDirectory, "managed-update-handoffs.sqlite");
    createManagedHandoffLeaseDatabase(currentDatabasePath)(true, () => undefined);
    const currentStore = createManagedHandoffLeaseStore({
      databasePath: currentDatabasePath,
      serviceManagerEnv: {},
    });
    expect(currentStore.read(packageRoot)).toEqual({ kind: "absent" });

    await repair();

    if (owner === "live") {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Handoff owners are live or unverified: PID ${previous.helper.pid}`,
        ),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(fixture.rows()).toEqual(rows);
      expect(publication.journal.read()).toEqual(record);
      expect(mocks.doctor).not.toHaveBeenCalled();
    } else {
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ok" }),
      );
      expectAbsent(packageRoot);
      expectSettlement("legacy handoff lease reclaimed");
      expect(fs.existsSync(`${anchor}.superseded-${record.descriptor.operationId}`)).toBe(true);
      expect(() => assertNoPendingPackageActivation(packageRoot)).not.toThrow();
    }
    expect(currentStore.read(packageRoot)).toEqual({ kind: "absent" });
  },
);
