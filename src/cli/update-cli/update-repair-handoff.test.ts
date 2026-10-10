import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffRecoveryFixture } from "../../infra/update-managed-service-handoff-recovery.test-support.js";
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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  doctor: vi.fn(),
  plugins: vi.fn(),
  convergence: vi.fn(),
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: async () => "skipped",
}));
vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
}));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-fresh-doctor.js", async (original) => ({
  ...(await original<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: mocks.doctor,
  completePostCorePluginUpdate: mocks.convergence,
}));
// Keep the registered command, finalizer lifecycle, handoff owner, and ledger real.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => undefined,
}));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));

const pluginResult: ProducedPluginUpdateResult = {
  assessment: { kind: "no-payload-repair" },
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
let state: OpenClawTestState;
let fixture: ReturnType<typeof createManagedHandoffRecoveryFixture>;

beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    label: "repair-handoff",
    env: {
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
      OPENCLAW_UPDATE_POST_CORE: undefined,
    },
  });
  fixture = createManagedHandoffRecoveryFixture(state.root);
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  await fs.writeFile(
    state.path("package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
  mocks.root.mockResolvedValue(state.root);
  mocks.doctor.mockReset().mockResolvedValue(undefined);
  mocks.plugins.mockReset().mockResolvedValue(pluginResult);
  mocks.convergence.mockReset().mockImplementation(async ({ pluginUpdate }) => ({
    pluginUpdate,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
  }));
  for (const method of ["log", "error", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => undefined);
  }
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

it("registered update repair settles a dead uncertain lease and admits the next updater", async () => {
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

  await withCliProcessScope(() =>
    runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
    }),
  );

  expect(mocks.doctor).toHaveBeenCalledOnce();
  expect(mocks.plugins).toHaveBeenCalledOnce();
  expect(fixture.store.read(state.root)).toEqual({ kind: "absent" });
  const runs = listUpdateRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    status: "succeeded",
    steps: expect.arrayContaining([
      expect.objectContaining({
        step: "finalize:handoff-settlement",
        status: "completed",
        detail: expect.stringContaining("legacy handoff lease reclaimed"),
      }),
    ]),
  });
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
  await expect(
    withUpdateCommandExecutor("next-update", async (executor) => {
      const fence = await executor.enter(state.root);
      fence.assertCurrent();
      return "admitted";
    }),
  ).resolves.toBe("admitted");
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

function seedLegacyLineage(nested = false, bound = false) {
  const previous = fixture.seed({ ageMs: 13 * 60 * 60_000 });
  const key = `${state.root}/.openclaw-update-child-01234567-89ab-cdef-0123-456789abcdef-lineage-${"a".repeat(64)}`;
  createManagedHandoffLeaseDatabase(state.path("handoff-control/managed-update-handoffs.sqlite"))(
    true,
    (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set({
            install_root: key,
            payload_json: JSON.stringify({
              version: 2,
              executor: bound ? previous.executor : previous.helper,
              helper: previous.helper,
              action: { kind: "update" },
            }),
          })
          .where("install_root", "=", state.root),
      ),
  );
  if (nested) {
    const retained = fixture.store.read(key);
    if (retained.kind !== "current") {
      throw new Error("Missing lineage fixture");
    }
    createManagedHandoffLeaseDatabase(state.path("handoff-control/managed-update-handoffs.sqlite"))(
      true,
      (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .insertInto("managed_update_handoffs")
            .values({
              install_root: `${key}/.openclaw-update-child-nested`,
              owner: retained.lease.owner,
              payload_json: retained.lease.payload,
              updated_at: retained.lease.updatedAt,
            }),
        ),
    );
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

it.each(["dead", "reused", "nested"] as const)(
  "repair reclaims a %s legacy child-lineage owner and admits the next update",
  async (identity) => {
    const key = seedLegacyLineage(identity === "nested");
    if (identity === "reused") {
      fixture.births.set(fixture.helper.pid, 99);
    }
    await withCliProcessScope(() =>
      runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
      }),
    );
    expect(fixture.store.read(key)).toEqual({ kind: "absent" });
    expect(fixture.store.read(`${key}/.openclaw-update-child-nested`)).toEqual({ kind: "absent" });
    expect(listUpdateRuns()[0]).toMatchObject({
      status: "succeeded",
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "finalize:handoff-settlement",
          status: "completed",
          detail: expect.stringContaining(key),
        }),
      ]),
    });
    await expect(
      withUpdateCommandExecutor("after-lineage-repair", async (executor) => {
        const fence = await executor.enter(state.root);
        fence.assertCurrent();
        return "admitted";
      }),
    ).resolves.toBe("admitted");
  },
);

it.each(["live", "uninspectable", "EPERM", "surviving group"] as const)(
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
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === fixture.helper.pid) {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
    }
    const retained = fixture.store.read(key);
    await withCliProcessScope(() =>
      runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
      }),
    );
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
    createManagedHandoffLeaseDatabase(state.path("handoff-control/managed-update-handoffs.sqlite"))(
      true,
      (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .insertInto("managed_update_handoffs")
            .values({
              install_root: second,
              owner: run.runId,
              payload_json: JSON.stringify({
                version: 2,
                executor: identity,
                helper: identity,
                action: { kind: "update" },
              }),
              updated_at: Date.now() - 13 * 60 * 60_000,
            }),
        ),
    );
    const retained = [fixture.store.read(first), fixture.store.read(second)];
    if (!pendingRollback) {
      mocks.doctor.mockImplementation(async () => {
        expect(fixture.readMetadata(fixture.current())?.facts.runIds).toEqual(
          expect.arrayContaining([run.runId]),
        );
      });
    }
    await withCliProcessScope(() =>
      runRegisteredCli({
        register: registerUpdateCli,
        argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
      }),
    );
    if (pendingRollback) {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("unverified rollback"),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect([fixture.store.read(first), fixture.store.read(second)]).toEqual(retained);
      expect(fixture.store.read(state.root)).toEqual({ kind: "absent" });
      expect(mocks.doctor).not.toHaveBeenCalled();
    } else {
      expect(fixture.store.read(first)).toEqual({ kind: "absent" });
      expect(fixture.store.read(second)).toEqual({ kind: "absent" });
      expect(listUpdateRuns()[0]?.status).toBe("succeeded");
    }
  },
);
