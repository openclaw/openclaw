import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { activateGatewayAgentDatabaseStartup } from "./server-agent-database-startup.js";

const mocks = vi.hoisted(() => ({
  migrate: vi.fn(),
  maintain: vi.fn(),
  journal: vi.fn(),
  opened: vi.fn(),
  refreshSecrets: vi.fn(),
  refreshModels: vi.fn(),
  replacement: vi.fn(),
  modelSnapshot: vi.fn(),
  snapshot: vi.fn(),
  revision: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// mock-isolation: This suite owns startup timers; filesystem observation has separate coverage.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory: () => ({ close() {} }),
}));

// mock-isolation: Path resolution needs no auth database or credential loaders.
vi.mock("../agents/auth-profiles/sqlite.js", () => ({
  resolveAuthProfileDatabasePath: (agentDir: string) =>
    path.join(agentDir, "openclaw-agent.sqlite"),
}));
// mock-isolation: Exercise admission and Gateway sequencing without native worker processes.
vi.mock("../infra/sqlite-readonly-worker.js", () => ({
  withSqliteReadOnlyWorkerScope: (run: () => Promise<unknown>) => run(),
}));
// mock-isolation: Journal transport is independent of the real pending-admission owner.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: mocks.journal,
}));
// mock-isolation: A controlled migration proves scheduling without scanning a database.
vi.mock("./server-startup-session-migration.js", () => ({
  prepareGatewayStartupSessions: async (params: unknown) => {
    await mocks.migrate(params);
    return [];
  },
  runGatewaySessionStartupMaintenance: mocks.maintain,
}));
// mock-isolation: Model preparation stays observable without loading provider plugins.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  refreshPreparedModelRuntimeSnapshots: mocks.refreshModels,
  getPreparedModelRuntimeSnapshot: mocks.modelSnapshot,
  getPendingPreparedModelRuntimeReplacement: mocks.replacement,
}));
// mock-isolation: Configured model inputs are not the behavior under test.
vi.mock("../agents/prepared-model-runtime.configured.js", () => ({
  listConfiguredOwnerInputs: (cfg: OpenClawConfig) =>
    Object.keys(cfg.agents!.entries!).map((agentId) => ({ agentId })),
}));
// mock-isolation: Track global revision/config publication without credentials or providers.
vi.mock("../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: mocks.snapshot,
  getActiveSecretsRuntimeSnapshotRevision: mocks.revision,
  refreshActiveSecretsRuntimeSnapshotForConfig: mocks.refreshSecrets,
}));
// mock-isolation: Capture startup diagnostics without process logging state.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: mocks.info, warn: mocks.warn }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

type StartupAdmission = NonNullable<
  Parameters<typeof activateGatewayAgentDatabaseStartup>[0]["admission"]
>;

function createFleet(
  agentIds = ["large", "small"],
  migrateAgent?: Parameters<StartupAdmission["activate"]>[0]["migrateAgent"],
  acpOnlyAgentIds: readonly string[] = [],
) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("startup-preparation-") };
  const acpOnly = new Set(acpOnlyAgentIds);
  const nativeAgentIds = agentIds.filter((agentId) => !acpOnly.has(agentId));
  const nativeEntries = nativeAgentIds.length > 0 ? nativeAgentIds : ["main"];
  let cfg: OpenClawConfig = {
    gateway: { auth: { mode: "token", token: "synthetic-before-refresh" } },
    agents: {
      entries: Object.fromEntries(nativeEntries.map((id) => [id, {}])),
      defaults: { systemAgent: { agentId: nativeEntries[0] } },
    },
    ...(acpOnlyAgentIds.length > 0 ? { acp: { allowedAgents: [...acpOnlyAgentIds] } } : {}),
  };
  const paths = agentIds.map((agentId) => resolveOpenClawAgentSqlitePath({ agentId, env }));
  for (const pathname of paths) {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, "synthetic file identity; native admission is mocked");
  }
  let revision = 0;
  const opened = createDeferredCore();
  let openCount = 0;
  mocks.opened.mockImplementation(() => {
    if (++openCount === agentIds.length) {
      opened.resolve();
    }
  });
  mocks.journal.mockResolvedValue("absent");
  mocks.refreshModels.mockResolvedValue(undefined);
  mocks.modelSnapshot.mockReturnValue({});
  mocks.migrate.mockImplementation(async ({ assertCurrent }) => assertCurrent());
  mocks.revision.mockImplementation(() => revision);
  mocks.snapshot.mockImplementation(() => ({
    sourceConfig: cfg,
    authStores: paths.flatMap((databasePath, index) =>
      acpOnly.has(agentIds[index]!) ? [] : [{ databasePath }],
    ),
  }));
  mocks.refreshSecrets.mockImplementation(
    async ({ assertCurrent }: { assertCurrent: () => void }) => {
      assertCurrent();
      // Resolved credentials may rotate while the authored session configuration stays fixed.
      cfg = structuredClone(cfg);
      revision++;
      cfg.gateway!.auth!.token = `synthetic-refresh-${revision}`;
      return true;
    },
  );
  const gates: ReturnType<typeof createDeferredCore<void>>[] = [];
  const hold = () => {
    const gate = createDeferredCore();
    gates.push(gate);
    return gate;
  };
  const inspections = agentIds.map(() =>
    createDeferredCore<{ incompatible: []; indeterminate: [] }>(),
  );
  const inspect = (index: number) =>
    inspections[index]!.resolve({ incompatible: [], indeterminate: [] });
  return {
    env,
    opened: opened.promise,
    hold,
    inspect,
    changeAgentDatabase: (agentId: string, change: "agent removal" | "database move") => {
      cfg = structuredClone(cfg);
      if (change === "agent removal") {
        delete cfg.agents!.entries![agentId];
      } else {
        const agentDir = path.join(env.OPENCLAW_STATE_DIR, "moved-agent");
        cfg.agents!.entries![agentId]!.agentDir = agentDir;
        cfg.session = { ...cfg.session, store: path.join(agentDir, "openclaw-agent.sqlite") };
      }
    },
    reloadConfig: () => {
      cfg = structuredClone(cfg);
    },
    bumpSecretsRevision: () => {
      revision++;
    },
    run: (
      run: (admission: StartupAdmission) => Promise<void>,
      preparationReady: Promise<void> = Promise.resolve(),
      postReadyWork: Promise<void> = Promise.resolve(),
    ) =>
      withAgentDatabaseStartupAdmission(async (admission) => {
        const refusals = admission.defer({
          env,
          reason: "foreground budget expired",
          inspections: agentIds.map((agentId, index) => ({
            target: { agentId, path: paths[index]! },
            result: inspections[index]!.promise,
          })),
        });
        recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
        const owner = admission.adopt();
        const activate = admission.activate.bind(admission);
        // Keep the real Gateway migration/publication contract; native open has its own suite.
        vi.spyOn(admission, "activate").mockImplementation((activation) =>
          activate({
            ...activation,
            migrateAgent: migrateAgent ?? activation.migrateAgent,
            openAgent: async ({ assertCurrent }) => {
              assertCurrent();
              mocks.opened();
            },
          }),
        );
        activateGatewayAgentDatabaseStartup({
          admission,
          preparationReady,
          waitForPostReadyWork: () => postReadyWork,
          getConfig: () => cfg,
          getPluginRegistry: vi.fn(),
          getPluginMetadataSnapshot: () => undefined,
          isCurrent: () => true,
          log: { info: vi.fn(), warn: vi.fn() },
        });
        try {
          await run(admission);
        } finally {
          inspections.forEach((_, index) => inspect(index));
          gates.forEach((gate) => gate.resolve());
          await owner.stop();
        }
      }),
  };
}

const recoveredMessage = "agent database recovered after background inspection and preparation";
const progressMessage = "agent database startup preparation still running";
const supersededRetryMessage = "agent database startup preparation was superseded; retrying";

function expectLog(log: typeof mocks.info, message: string, fields: Record<string, unknown>) {
  expect(log).toHaveBeenCalledWith(message, expect.objectContaining(fields));
}

function expectAdmission(fleet: ReturnType<typeof createFleet>, agentId: string, code?: string) {
  const refusal = readAgentDatabaseAdmissionRefusal(agentId, fleet);
  if (code) {
    expect(refusal?.code).toBe(code);
  } else {
    expect(refusal).toBeUndefined();
  }
}

it("admits configured ACP-only stores without native runtime publication", async ({ signal }) => {
  const fleet = createFleet(["codex"], undefined, ["codex"]);
  await fleet.run(async (admission) => {
    fleet.inspect(0);
    await withinTest(admission.waitForAgentPreparation("codex", fleet)!, signal);
    expectAdmission(fleet, "codex");
    expect(mocks.refreshSecrets).not.toHaveBeenCalled();
    expect(mocks.refreshModels).not.toHaveBeenCalled();
  });
});

it("admits agents before transcript repair and joins repair on shutdown", async ({ signal }) => {
  const fleet = createFleet();
  const entered = createDeferredCore();
  const release = fleet.hold();
  const postReady = fleet.hold();
  mocks.maintain.mockImplementation(async ({ assertCurrent }) => {
    assertCurrent();
    entered.resolve();
    await release.promise;
    assertCurrent();
  });
  await fleet.run(
    async (admission) => {
      fleet.inspect(0);
      await withinTest(admission.waitForAgentPreparation("large", fleet)!, signal);
      expectAdmission(fleet, "large");
      expect(admission.waitForAgentPreparation("large", fleet)).toBeUndefined();
      expect(mocks.maintain).not.toHaveBeenCalled();
      postReady.resolve();
      await withinTest(entered.promise, signal);
      fleet.inspect(1);
      await vi.advanceTimersByTimeAsync(0);
      expectAdmission(fleet, "small");
      expect(mocks.refreshModels).toHaveBeenCalledTimes(2);
      let stopped = false;
      const stopping = admission.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(mocks.warn).not.toHaveBeenCalled();
    },
    Promise.resolve(),
    postReady.promise,
  );
});

it("admits a small deferred agent while an earlier agent's session migration is blocked", async ({
  signal,
}) => {
  const fleet = createFleet();
  const migrationEntered = createDeferredCore();
  const releaseMigration = fleet.hold();
  mocks.migrate.mockImplementation(async ({ agentIds, assertCurrent }) => {
    assertCurrent();
    if (agentIds.has("large")) {
      migrationEntered.resolve();
      await releaseMigration.promise;
    }
    assertCurrent();
  });
  await fleet.run(async () => {
    fleet.inspect(0);
    await withinTest(migrationEntered.promise, signal);
    fleet.inspect(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expectAdmission(fleet, "small");
    expectAdmission(fleet, "large", "agent-database-inspection-pending");
    expect(mocks.warn).toHaveBeenCalledWith(progressMessage, {
      agentId: "large",
      phase: "migration",
      elapsedMs: 60_000,
      phaseElapsedMs: 60_000,
    });
    expectLog(mocks.info, recoveredMessage, {
      agentId: "small",
      elapsedMs: expect.any(Number),
      phaseDurationsMs: expect.objectContaining({
        inspection: expect.any(Number),
        migration: 0,
        secrets: 0,
        models: 0,
        publication: 0,
      }),
    });
    // B's secrets publication replaced the config while A was migrating.
    releaseMigration.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expectAdmission(fleet, "large");
    expectLog(mocks.info, recoveredMessage, {
      agentId: "large",
      elapsedMs: 60_000,
      phaseDurationsMs: expect.objectContaining({ migration: 60_000 }),
    });
    mocks.warn.mockClear();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

it("holds the publication turn through models and the final deletion check", async ({ signal }) => {
  const fleet = createFleet();
  const modelsEntered = createDeferredCore();
  const releaseModels = fleet.hold();
  const journalEntered = createDeferredCore();
  const releaseJournal = fleet.hold();
  mocks.refreshModels.mockImplementation(async (_cfg, { agentIds, isPublicationCurrent }) => {
    if (agentIds.has("large")) {
      modelsEntered.resolve();
      await releaseModels.promise;
    }
    expect(isPublicationCurrent()).toBe(true);
  });
  let largeJournalReads = 0;
  mocks.journal.mockImplementation(async (agentId) => {
    if (agentId === "large" && ++largeJournalReads === 2) {
      journalEntered.resolve();
      await releaseJournal.promise;
    }
    return "absent";
  });
  await fleet.run(async () => {
    fleet.inspect(0);
    await withinTest(modelsEntered.promise, signal);
    fleet.inspect(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.migrate).toHaveBeenCalledTimes(2);
    expect(mocks.refreshSecrets).toHaveBeenCalledTimes(1);
    expectLog(mocks.warn, progressMessage, {
      agentId: "small",
      phase: "publication-wait",
      publishingAgentId: "large",
    });
    releaseModels.resolve();
    await withinTest(journalEntered.promise, signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.refreshSecrets).toHaveBeenCalledTimes(1);
    expectAdmission(fleet, "small", "agent-database-inspection-pending");
    releaseJournal.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expectAdmission(fleet, "small");
    expectAdmission(fleet, "large");
    expect(
      mocks.info.mock.calls
        .filter(([message]) => message === recoveredMessage)
        .map(([, fields]) => fields.agentId),
    ).toEqual(["large", "small"]);
  });
});

it("keeps database opens off readiness and retains the four-agent migration pool", async ({
  signal,
}) => {
  const agentIds = ["first", "second", "third", "fourth", "fifth"];
  const fleet = createFleet(agentIds, async ({ agentId, assertCurrent }) => {
    await mocks.migrate({ agentIds: new Set([agentId]), assertCurrent });
  });
  const ready = fleet.hold();
  const releases = agentIds.map(() => fleet.hold());
  const fourMigrating = createDeferredCore();
  const fifthMigrating = createDeferredCore();
  const allAdmitted = createDeferredCore();
  let migrating = 0;
  let admitted = 0;
  mocks.info.mockImplementation((message) => {
    if (message === recoveredMessage && ++admitted === agentIds.length) {
      allAdmitted.resolve();
    }
  });
  mocks.migrate.mockImplementation(async ({ agentIds: selected, assertCurrent }) => {
    const index = agentIds.findIndex((id) => selected.has(id));
    if (++migrating === 4) {
      fourMigrating.resolve();
    } else if (migrating === 5) {
      fifthMigrating.resolve();
    }
    await releases[index]!.promise;
    assertCurrent();
  });
  await fleet.run(async () => {
    agentIds.forEach((_, index) => fleet.inspect(index));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.opened).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    for (const agentId of agentIds) {
      expectAdmission(fleet, agentId, "agent-database-inspection-pending");
      expectLog(mocks.warn, progressMessage, { agentId, phase: "readiness" });
    }
    ready.resolve();
    await withinTest(fleet.opened, signal);
    await withinTest(fourMigrating.promise, signal);
    expect(mocks.migrate).toHaveBeenCalledTimes(4);
    const enteredAgent = agentIds.find((id) => mocks.migrate.mock.calls[0]![0].agentIds.has(id))!;
    releases[agentIds.indexOf(enteredAgent)]!.resolve();
    await withinTest(fifthMigrating.promise, signal);
    expect(mocks.migrate).toHaveBeenCalledTimes(5);
    releases.forEach((release) => release.resolve());
    await withinTest(allAdmitted.promise, signal);
    for (const agentId of agentIds) {
      expectAdmission(fleet, agentId);
    }
  }, ready.promise);
});

it("cancels unopened agent preparation when the Gateway closes before readiness", async () => {
  const fleet = createFleet(["worker"]);
  const ready = fleet.hold();
  await fleet.run(async (admission) => {
    fleet.inspect(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expectLog(mocks.warn, progressMessage, { agentId: "worker", phase: "readiness" });
    await admission.stop();
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.opened).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expectAdmission(fleet, "worker", "agent-database-inspection-pending");
    expect(vi.getTimerCount()).toBe(0);
  }, ready.promise);
});

it.for(["agent removal", "database move", "deletion", "shutdown"] as const)(
  "does not readmit after %s during migration",
  async (outcome, { signal }) => {
    const fleet = createFleet(["large"]);
    const entered = createDeferredCore();
    const release = fleet.hold();
    mocks.migrate.mockImplementation(async ({ assertCurrent }) => {
      entered.resolve();
      await release.promise;
      assertCurrent();
    });
    await fleet.run(async (admission) => {
      fleet.inspect(0);
      await withinTest(entered.promise, signal);
      let stopping: Promise<void> | undefined;
      let stopped = false;
      if (outcome === "agent removal" || outcome === "database move") {
        fleet.changeAgentDatabase("large", outcome);
      } else if (outcome === "deletion") {
        mocks.journal.mockResolvedValue("complete");
      } else {
        stopping = admission.stop().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stopped).toBe(false);
        expect(mocks.warn).not.toHaveBeenCalledWith(progressMessage, expect.anything());
        expect(vi.getTimerCount()).toBe(0);
      }
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await stopping;
      const refusal = readAgentDatabaseAdmissionRefusal("large", fleet);
      expect(refusal?.code).toBe(
        outcome === "shutdown"
          ? "agent-database-inspection-pending"
          : "agent-database-inspection-failed",
      );
      expect(mocks.info).not.toHaveBeenCalledWith(recoveredMessage, expect.anything());
      if (outcome !== "shutdown") {
        expectLog(mocks.warn, "agent database remains degraded", {
          agentId: "large",
          reason: expect.stringContaining(
            outcome === "deletion" ? "deleted" : "database configuration changed",
          ),
          elapsedMs: expect.any(Number),
          phaseDurationsMs: expect.any(Object),
        });
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  },
);

it.for([
  "config",
  "secrets",
  "secrets preparation",
  "model runtime",
  "queued model runtime",
] as const)(
  "retries a superseded publication after %s replacement",
  async (replacement, { signal }) => {
    const fleet = createFleet(["large"]);
    const entered = createDeferredCore();
    const release = fleet.hold();
    const successor = fleet.hold();
    const joining = createDeferredCore();
    mocks.replacement.mockImplementation(() => {
      joining.resolve();
      return successor.promise;
    });
    if (replacement === "queued model runtime") {
      mocks.modelSnapshot.mockReturnValueOnce(undefined);
    }
    if (replacement === "secrets preparation") {
      const refresh = mocks.refreshSecrets.getMockImplementation()!;
      mocks.refreshSecrets.mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        return refresh(params);
      });
    } else {
      mocks.refreshModels.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (replacement === "model runtime") {
          throw new PreparedModelRuntimePublicationSupersededError("publication was superseded");
        }
      });
    }
    await fleet.run(async (admission) => {
      fleet.inspect(0);
      await withinTest(entered.promise, signal);
      if (replacement === "secrets") {
        fleet.bumpSecretsRevision();
      } else if (replacement === "config" || replacement === "secrets preparation") {
        fleet.reloadConfig();
      }
      release.resolve();
      if (replacement === "model runtime" || replacement === "queued model runtime") {
        await withinTest(joining.promise, signal);
        expectAdmission(fleet, "large", "agent-database-inspection-pending");
        expect(mocks.refreshModels).toHaveBeenCalledTimes(1);
        successor.resolve();
      }
      await withinTest(admission.waitForAgentPreparation("large", fleet)!, signal);
      expectAdmission(fleet, "large");
      expectLog(mocks.info, recoveredMessage, { agentId: "large" });
      expectLog(mocks.warn, supersededRetryMessage, { agentId: "large", attempt: 1 });
      expect(mocks.opened).toHaveBeenCalledTimes(1);
      expect(mocks.migrate).toHaveBeenCalledTimes(1);
      expect(mocks.refreshSecrets).toHaveBeenCalledTimes(2);
    });
  },
);

it.for(["secrets", "model runtime"] as const)(
  "fails admission after four continuously superseded %s publications",
  async (replacement, { signal }) => {
    const fleet = createFleet(["large"]);
    mocks.refreshModels.mockImplementation(async () => {
      if (replacement === "model runtime") {
        throw new PreparedModelRuntimePublicationSupersededError("publication was superseded");
      }
      fleet.bumpSecretsRevision();
    });
    await fleet.run(async (admission) => {
      fleet.inspect(0);
      await withinTest(admission.waitForAgentPreparation("large", fleet)!, signal);
      expect(readAgentDatabaseAdmissionRefusal("large", fleet)).toMatchObject({
        code: "agent-database-inspection-failed",
        reason: expect.stringContaining("preparation was superseded"),
        repairHint: expect.stringContaining("openclaw doctor --fix"),
      });
      expect(mocks.refreshModels).toHaveBeenCalledTimes(4);
      expect(mocks.opened).toHaveBeenCalledTimes(1);
      expect(mocks.migrate).toHaveBeenCalledTimes(1);
      expect(mocks.info).not.toHaveBeenCalledWith(recoveredMessage, expect.anything());
    });
  },
);

it.for(["initial", "successor"] as const)(
  "preserves a genuine %s model publication failure without retrying",
  async (publication, { signal }) => {
    const fleet = createFleet(["main"]);
    const error = new Error("Cannot load model catalog: permission denied");
    mocks.refreshModels.mockRejectedValue(
      publication === "initial"
        ? error
        : new PreparedModelRuntimePublicationSupersededError("publication was superseded"),
    );
    mocks.replacement.mockImplementation(async () => {
      throw error;
    });
    await fleet.run(async (admission) => {
      fleet.inspect(0);
      await withinTest(admission.waitForAgentPreparation("main", fleet)!, signal);
      expect(readAgentDatabaseAdmissionRefusal("main", fleet)).toMatchObject({
        code: "agent-database-inspection-failed",
        reason: error.message,
        repairHint: expect.stringContaining("openclaw doctor --fix"),
      });
      expect(mocks.refreshModels).toHaveBeenCalledTimes(1);
      expect(mocks.info).not.toHaveBeenCalledWith(recoveredMessage, expect.anything());
    });
  },
);

it.for(["agent removal", "database move"] as const)(
  "does not readmit after %s during publication",
  async (outcome, { signal }) => {
    const fleet = createFleet(["large"]);
    const modelsEntered = createDeferredCore();
    const releaseModels = fleet.hold();
    mocks.refreshModels.mockImplementation(async () => {
      modelsEntered.resolve();
      await releaseModels.promise;
    });
    await fleet.run(async (admission) => {
      fleet.inspect(0);
      await withinTest(modelsEntered.promise, signal);
      fleet.changeAgentDatabase("large", outcome);
      releaseModels.resolve();
      await withinTest(admission.waitForAgentPreparation("large", fleet)!, signal);
      const refusal = readAgentDatabaseAdmissionRefusal("large", fleet);
      expect(refusal?.code).toBe("agent-database-inspection-failed");
      expect(mocks.info).not.toHaveBeenCalledWith(recoveredMessage, expect.anything());
      expectLog(mocks.warn, "agent database remains degraded", {
        agentId: "large",
        reason: expect.stringContaining("database configuration changed"),
      });
    });
  },
);
