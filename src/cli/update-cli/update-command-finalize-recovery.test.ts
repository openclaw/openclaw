import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as maintenance from "../../commands/doctor-maintenance.js";
import * as automatic from "../../commands/triage-failure.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../../infra/update-managed-service-handoff-lease.js";
import { inspectUpdateRecoveryBackups } from "../../infra/update-recovery-backup.js";
import { UpdateRecoveryPublicationUnavailableError } from "../../infra/update-recovery-publication.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import * as triage from "../../infra/update-triage.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as shared from "./shared.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { UpdateCommandFailure } from "./update-command-result.js";

// Component proof: Doctor/plugin operations are simulated. Capture, private reverse
// preparation/refusal, maintenance, executor, finalizer and triage dispatch stay real.
const mocks = vi.hoisted(() => ({
  doctor: vi.fn<() => Promise<void>>(),
  caught: undefined as unknown,
}));
vi.mock("./update-command-fresh-doctor.js", async (original) => ({
  ...(await original<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: mocks.doctor,
  completePostCorePluginUpdate: async (params: { pluginUpdate: unknown }) => ({
    pluginUpdate: params.pluginUpdate,
    configSnapshot: await readConfigFileSnapshot(),
  }),
}));
vi.mock("./update-command-triage.js", async (original) => {
  const actual = await original<typeof import("./update-command-triage.js")>();
  return {
    ...actual,
    withUpdateFailureTriage: (opts, target, run) =>
      actual.withUpdateFailureTriage(opts, target, async () => {
        try {
          await run();
        } catch (error) {
          mocks.caught = error;
          throw error;
        }
      }),
  } satisfies typeof actual;
});
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: async () => {},
}));
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: async () => ({
    status: "error",
    changed: false,
    warnings: [],
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: false, outcomes: [] },
    integrityDrifts: [],
  }),
}));

let state: OpenClawTestState;
let root: string;
let primary: UpdateCommandFailure;
let reported: unknown[];
type PreparedTriage = Awaited<ReturnType<typeof triage.prepareUpdateFailureTriage>>;
let dispatch = vi.fn<PreparedTriage>();
let publishedLeases: string[];
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "finalizer-recovery",
    env: {
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
      OPENCLAW_UPDATE_POST_CORE: undefined,
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    },
  });
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  root = state.path("install");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.4"}');
  const coordinator = state.path("coordinator");
  await fs.mkdir(coordinator, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  vi.spyOn(shared, "tryWriteCompletionCache").mockResolvedValue("skipped");
  primary = new UpdateCommandFailure(
    {
      status: "error",
      mode: "npm",
      root,
      reason: "named-doctor-failure",
      steps: [],
      durationMs: 7,
    },
    7,
    "Original Doctor failure",
    {
      automaticTriage: {
        kind: "update",
        phase: "doctor",
        error: "Original Doctor failure",
        installationRoot: root,
        gateway: "preserve",
      },
    },
  );
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:retained-before", env: state.env },
    { sessionId: "before", updatedAt: 1 },
  );
  await closeOpenClawAgentDatabasesAsync();
  mocks.doctor.mockReset().mockRejectedValue(primary);
  mocks.caught = undefined;
  reported = [];
  publishedLeases = [];
  dispatch = vi.fn<PreparedTriage>().mockResolvedValue({ status: "cancelled" });
  vi.spyOn(triage, "prepareUpdateFailureTriage").mockResolvedValue(dispatch);
  vi.spyOn(automatic, "triageAfterFailure").mockImplementation(async () => {
    publishedLeases.push(createManagedHandoffLeaseStore().read(root).kind);
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    reported.push(value);
    publishedLeases.push(createManagedHandoffLeaseStore().read(root).kind);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

async function invoke() {
  return updateFinalizeCommand({ json: true, yes: true, deferCompletionCache: true }).then(
    () => undefined,
    (error: unknown) => error,
  );
}
function mutateLease(sql: string, key?: string) {
  const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
  try {
    if (key) {
      db.prepare(sql).run(key);
    } else {
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}

it.each(["ordinary", "sibling"])(
  "retains typed failure and automatic classification after clean no-publication refusal: %s",
  async (kind) => {
    if (kind === "ordinary") {
      mocks.doctor.mockImplementation(async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:retained-after", env: state.env },
          { sessionId: "newer", updatedAt: 2 },
        );
        await closeOpenClawAgentDatabasesAsync();
        throw primary;
      });
    }
    if (kind === "sibling") {
      const sibling = state.path("sibling");
      await fs.mkdir(sibling);
      expect(
        createManagedHandoffLeaseStore().acquire(sibling, "sibling-owner", { kind: "update" }).kind,
      ).toBe("acquired");
      mocks.doctor.mockImplementation(async () => {
        mutateLease(
          "UPDATE managed_update_handoffs SET owner = 'replacement' WHERE install_root = ?",
          sibling,
        );
        throw primary;
      });
    }
    expect(await invoke()).toMatchObject({ name: "ExitError", code: 7 });
    expect(automatic.triageAfterFailure).toHaveBeenCalledWith(
      defaultRuntime,
      primary.automaticTriage,
      undefined,
      expect.any(String),
    );
    expect(dispatch.mock.calls.length).toBe(0);
    expect(publishedLeases).toEqual(["absent"]);
    expect(reported).toEqual([]);
    const causes = collectNestedErrorCandidates(mocks.caught);
    expect(causes).toContain(primary);
    expect(
      causes.some(
        (error) =>
          error instanceof Error && error.message.includes("No package or state was replaced"),
      ),
    ).toBe(true);
    const captures = await inspectUpdateRecoveryBackups();
    expect(captures).toHaveLength(1);
    const [capture] = captures;
    if (!capture) {
      throw new Error("Expected the retained capture");
    }
    const directory = capture.ref.directory;
    for (const generation of ["", "candidate", "prepared"]) {
      expect((await fs.stat(path.join(directory, generation, "manifest.json"))).isFile()).toBe(
        true,
      );
    }
    expect(
      loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: "agent:main:retained-before",
        env: state.env,
      })?.sessionId,
    ).toBe("before");
    if (kind === "ordinary") {
      expect(
        loadSessionEntryReadOnly({
          agentId: "main",
          sessionKey: "agent:main:retained-after",
          env: state.env,
        })?.sessionId,
      ).toBe("newer");
    }
    expect(capture.terminalOutcome).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]?.status).toBe("failed");
  },
);

it("waits for actual maintenance release before printing the original plugin failure", async () => {
  mocks.doctor.mockResolvedValue(undefined);
  const entered = createDeferred();
  const permit = createDeferred();
  let admissions = 0;
  const begin = maintenance.beginDoctorMaintenance;
  vi.spyOn(maintenance, "beginDoctorMaintenance").mockImplementation(async (params) => {
    const admitted = await begin(params);
    if (!admitted || ++admissions === 1) {
      return admitted;
    }
    return {
      ...admitted,
      release: async () => {
        entered.resolve();
        await permit.promise;
        await admitted.release();
      },
    };
  });
  const operation = invoke();
  await entered.promise;
  expect(reported).toEqual([]);
  expect(automatic.triageAfterFailure).not.toHaveBeenCalled();
  expect(listUpdateRuns({ limit: 1 })[0]?.status).toBe("running");
  permit.resolve();
  expect(await operation).toMatchObject({ name: "ExitError", code: 1 });
  expect(reported).toEqual([
    expect.objectContaining({
      status: "error",
      mode: "finalize",
      restart: false,
      postUpdate: expect.objectContaining({
        plugins: expect.objectContaining({ status: "error" }),
      }),
    }),
  ]);
  expect(publishedLeases).toEqual(["absent"]);
});

it("retains both refusal and maintenance cleanup cause as pending without ordinary triage", async () => {
  let admissions = 0;
  const begin = maintenance.beginDoctorMaintenance;
  vi.spyOn(maintenance, "beginDoctorMaintenance").mockImplementation(async (params) => {
    const admitted = await begin(params);
    if (!admitted || ++admissions === 1) {
      return admitted;
    }
    return {
      ...admitted,
      release: async () => {
        await admitted.release();
        throw new Error("fixture maintenance settlement failed");
      },
    };
  });
  expect(await invoke()).toMatchObject({ name: "ExitError" });
  expect(reported).toEqual([
    expect.objectContaining({
      status: "error",
      reason: "named-doctor-failure",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    }),
  ]);
  expect(automatic.triageAfterFailure).not.toHaveBeenCalled();
  expect(dispatch.mock.calls.length).toBe(0);
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("fixture maintenance settlement failed"),
  );
  const causes = collectNestedErrorCandidates(mocks.caught);
  expect(causes).toContain(primary);
  expect(
    causes.some(
      (error) =>
        error instanceof Error && error.message.includes("No package or state was replaced"),
    ),
  ).toBe(true);
});

it.each(["revoked", "release-fails"])(
  "never unwraps outer executor %s into an ordinary failure",
  async (kind) => {
    let admissions = 0;
    const begin = maintenance.beginDoctorMaintenance;
    vi.spyOn(maintenance, "beginDoctorMaintenance").mockImplementation(async (params) => {
      const admitted = await begin(params);
      if (!admitted || ++admissions === 1) {
        return admitted;
      }
      return {
        ...admitted,
        release: async () => {
          await admitted.release();
          if (kind === "revoked") {
            mutateLease(
              "UPDATE managed_update_handoffs SET owner = 'replacement' WHERE install_root = ?",
              root,
            );
          } else {
            mutateLease(
              "CREATE TRIGGER deny_finalizer_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture executor release denied'); END",
            );
          }
        },
      };
    });
    const error = await invoke();
    expect(error).toMatchObject({ name: "ExitError" });
    const causes = collectNestedErrorCandidates(mocks.caught);
    expect(causes).toContain(primary);
    expect(causes.some((cause) => cause instanceof UpdateRecoveryPublicationUnavailableError)).toBe(
      true,
    );
    expect(reported).toEqual([
      expect.objectContaining({
        status: "error",
        reason: "named-doctor-failure",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      }),
    ]);
    expect(automatic.triageAfterFailure).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.length).toBe(0);
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("current");
  },
);
