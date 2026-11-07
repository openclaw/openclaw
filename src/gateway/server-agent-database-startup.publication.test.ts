// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import {
  cancelPreparedModelRuntimeRefresh,
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { activateGatewayAgentDatabaseStartup } from "./server-agent-database-startup.js";

const external = vi.hoisted(() => ({
  snapshot: vi.fn(),
  revision: vi.fn(),
  refresh: vi.fn(),
}));

// mock-isolation: File observation and native database opening have separate admission coverage.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory: () => ({ close() {} }),
}));
vi.mock("../infra/sqlite-readonly-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-readonly-worker.js")>()),
  withSqliteReadOnlyWorkerScope: (run: () => Promise<unknown>) => run(),
}));
// mock-isolation: Fixed successful database I/O leaves real admission and model publication owners.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: async () => "absent",
}));
// mock-isolation: Native database opening is covered by the existing admission tests.
vi.mock("../state/openclaw-agent-execution.js", () => ({
  prepareOpenClawAgentDatabaseExecution: async (_input: unknown, assertCurrent: () => void) =>
    assertCurrent(),
}));
// mock-isolation: Transcript migration is independent of deferred model publication.
vi.mock("./server-startup-session-migration.js", () => ({
  prepareGatewayStartupSessions: async ({ assertCurrent }: { assertCurrent: () => void }) => {
    assertCurrent();
    return [];
  },
  runGatewaySessionStartupMaintenance: async () => {},
}));
// mock-isolation: Synthetic secrets revisions avoid loading operator credentials.
vi.mock("../secrets/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/runtime.js")>()),
  getActiveSecretsRuntimeSnapshot: external.snapshot,
  getActiveSecretsRuntimeSnapshotRevision: external.revision,
  refreshActiveSecretsRuntimeSnapshotForConfig: external.refresh,
}));

const fixture = usePreparedModelRuntimeHarness({ label: "deferred-startup-publication" });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.for(["complete", "shutdown"] as const)(
  "keeps deferred admission pending beyond the ordinary model deadline until %s",
  async (outcome, { signal }) => {
    const agentId = "worker";
    fixture.mocks.configuredAgentIds = [agentId];
    const env = fixture.state.env;
    let cfg: OpenClawConfig = {
      agents: {
        entries: { worker: {} },
        defaults: { systemAgent: { agentId } },
      },
    };
    const databasePath = await fixture.state.writeAuthProfiles(
      { version: 1, profiles: {} },
      agentId,
    );
    let revision = 0;
    external.revision.mockImplementation(() => revision);
    external.snapshot.mockImplementation(() => ({
      sourceConfig: cfg,
      authStores: [{ databasePath }],
    }));
    external.refresh.mockImplementation(
      async ({ assertCurrent }: { assertCurrent: () => void }) => {
        assertCurrent();
        cfg = structuredClone(cfg);
        revision++;
        return true;
      },
    );
    const acquiring = createDeferredCore();
    const acquired = createDeferredCore();
    const aborted = createDeferredCore();
    fixture.mocks.prepareStaticCatalog.mockImplementation(async (input) => {
      const options = input as { signal: AbortSignal };
      const onAbort = () => aborted.resolve();
      options.signal.addEventListener("abort", onAbort, { once: true });
      acquiring.resolve();
      try {
        await Promise.race([acquired.promise, aborted.promise]);
        options.signal.throwIfAborted();
        return { entries: [] };
      } finally {
        options.signal.removeEventListener("abort", onAbort);
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await withAgentDatabaseStartupAdmission(async (admission) => {
      recordAgentDatabaseAdmissions(
        admission.defer({
          env,
          reason: "synthetic foreground inspection budget expired",
          inspections: [
            {
              target: { agentId, path: databasePath },
              result: Promise.resolve({ incompatible: [], indeterminate: [] }),
            },
          ],
        }),
        { env, source: "startup" },
      );
      const owner = admission.adopt();
      activateGatewayAgentDatabaseStartup({
        admission,
        preparationReady: Promise.resolve(),
        waitForPostReadyWork: async () => {},
        getConfig: () => cfg,
        getPluginRegistry: () => createEmptyPluginRegistry(),
        getPluginMetadataSnapshot: () => undefined,
        isCurrent: () => !admission.isStopped,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      const prepared = admission.waitForAgentPreparation(agentId, { env })!;
      void prepared.catch(() => {});
      try {
        await withinTest(acquiring.promise, signal);
        await vi.advanceTimersByTimeAsync(120_001);
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })?.code).toBe(
          "agent-database-inspection-pending",
        );
        expect(getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, cfg))).toBeUndefined();
        if (outcome === "complete") {
          acquired.resolve();
          await withinTest(prepared, signal);
          expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
          expect(getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, cfg))).toBeDefined();
        } else {
          // Gateway shutdown cancels model acquisition before joining the deferred admission owner.
          cancelPreparedModelRuntimeRefresh();
          await withinTest(owner.stop(), signal);
          await withinTest(aborted.promise, signal);
          expect(readAgentDatabaseAdmissionRefusal(agentId, { env })?.code).toBe(
            "agent-database-inspection-pending",
          );
          expect(getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, cfg))).toBeUndefined();
        }
      } finally {
        acquired.resolve();
        await owner.stop();
        vi.useRealTimers();
      }
    });
  },
);

it("releases the background publication queue after startup grace without publishing retired work", async ({
  signal,
}) => {
  const agentId = "worker";
  fixture.mocks.configuredAgentIds = [agentId];
  const initial = { messages: { responsePrefix: "initial" } };
  const latest = { messages: { responsePrefix: "latest" } };
  const acquiring = createDeferredCore();
  const finishRetiredWork = createDeferredCore();
  let oldSignal: AbortSignal | undefined;
  let retiredWorkFinished = false;
  fixture.mocks.prepareStaticCatalog.mockImplementation(async (input) => {
    const options = input as { config: OpenClawConfig; signal: AbortSignal };
    if (options.config.messages?.responsePrefix === "initial") {
      oldSignal = options.signal;
      acquiring.resolve();
      // An aborted acquisition can still own finite cleanup before its raw work settles.
      await finishRetiredWork.promise;
      retiredWorkFinished = true;
    }
    return { entries: [] };
  });
  const publications: Array<string | undefined> = [];
  const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
    if (phase === "published") {
      for (const cfg of [initial, latest]) {
        const snapshot = getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, cfg));
        if (snapshot) {
          publications.push(snapshot.config.messages?.responsePrefix);
        }
      }
    }
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const publication = refreshPreparedModelRuntimeSnapshots(initial, {
    gatewayLifecycle: true,
    startup: "background",
    catalogMode: "static",
  }).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  let successor: Promise<void> | undefined;
  try {
    await withinTest(acquiring.promise, signal);
    const prepareSuccessor = vi.fn(() => latest);
    successor = refreshPreparedModelRuntimeSnapshots(prepareSuccessor, { catalogMode: "static" });
    void successor.catch(() => {});
    expect(oldSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(prepareSuccessor).toHaveBeenCalledOnce();
    expect(retiredWorkFinished).toBe(false);
    expect(settled).toBe(false);
    expect(getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, latest))).toBeUndefined();
    finishRetiredWork.resolve();
    expect(await withinTest(publication, signal)).toBeInstanceOf(
      PreparedModelRuntimePublicationSupersededError,
    );
    await withinTest(successor, signal);
    expect(getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, latest))?.config).toBe(
      latest,
    );
    expect(publications).not.toContain("initial");
    expect(publications).toContain("latest");
  } finally {
    finishRetiredWork.resolve();
    await Promise.allSettled([publication, successor]);
    unregister();
    vi.useRealTimers();
  }
});
