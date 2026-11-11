import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";
import { catalogHost, catalogSession } from "./session-catalog.fixtures.test-support.js";
import { sessionCatalogHandlers } from "./session-catalog.js";

afterEach(() => vi.restoreAllMocks());

const key = "agent:main:adopted";
const original = {
  sessionId: "original-instance",
  updatedAt: 1,
  pluginOwnerId: "fixture",
  createdActor: { type: "system" as const, id: "original-owner" },
};

function session(overrides: Partial<SessionCatalogSession> = {}): SessionCatalogSession {
  return catalogSession("native-thread", { sessionKey: key, ...overrides });
}

function hosts(sessions: SessionCatalogSession[]): SessionCatalogHost[] {
  return [catalogHost({ hostId: "gateway:fixture", label: "Fixture", sessions })];
}

const payload = (respond: ReturnType<typeof vi.fn>) => respond.mock.calls[0]?.[1];
const firstHost = (respond: ReturnType<typeof vi.fn>) => payload(respond)?.catalogs[0]?.hosts[0];
const replace = (entry: Partial<typeof original> & { label?: string }) =>
  replaceSessionEntrySync({ agentId: "main", sessionKey: key }, { ...original, ...entry });
function expectSnapshot(host: SessionCatalogHost, label: string, numbers: number[]) {
  expect(host).toMatchObject({ label, sessions: [{ pullRequest: { numbers } }] });
}

async function withCatalog(
  run: (fixture: {
    list: () => Promise<ReturnType<typeof vi.fn>>;
    setList: (list: SessionCatalogProvider["list"]) => void;
    projection: SessionRowProjection;
    state: OpenClawTestState;
  }) => Promise<void>,
  options: { otherEntryCount?: number; agents?: OpenClawConfig["agents"] } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: options.agents ?? {
        entries: { main: { agentDir: state.agentDir("main") } },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync({ agentId: "main", sessionKey: key }, original);
    for (let index = 0; index < (options.otherEntryCount ?? 0); index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
        { sessionId: `unrelated-${index}`, updatedAt: 1 },
      );
    }
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      context,
      modelCatalog: [],
    });
    bindSessionRowProjection(context, () => projection);
    const previous = captureActivePluginRegistrySnapshot();
    const provider: SessionCatalogProvider = {
      id: "fixture",
      label: "Fixture",
      list: async ({ sessionEntries }) => {
        const adopted = sessionEntries
          ?.entriesForCatalog?.()
          .find((entry) => entry.sessionKey === key);
        return hosts(adopted ? [session()] : []);
      },
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    };
    const registry = createEmptyPluginRegistry();
    registry.sessionCatalogs.push({ pluginId: "fixture", source: "fixture", provider });
    markPluginRegistryActive(registry);
    setActivePluginRegistry(registry);
    try {
      await run({
        projection,
        state,
        setList: (list) => {
          provider.list = list;
        },
        list: async () => {
          const respond = vi.fn();
          await sessionCatalogHandlers["sessions.catalog.list"]!({
            params: { catalogId: "fixture", agentId: "main" },
            context,
            client: { connect: { role: "operator", scopes: ["operator.admin"] } },
            respond,
          } as never);
          return respond;
        },
      });
    } finally {
      projection.dispose();
      restoreActivePluginRegistrySnapshot(previous);
    }
  });
}

it.each(["planning", "delivery"])(
  "keeps healthy catalog entries when another configured agent is deleted before %s",
  async (phase) => {
    await withCatalog(
      async ({ list, setList, projection, state }) => {
        const retiringKey = "agent:retiring:adopted";
        replaceSessionEntrySync(
          { agentId: "retiring", sessionKey: retiringKey },
          { ...original, sessionId: "retiring-instance" },
        );
        const pending = createAgentDatabaseInspectionRefusal({
          agentId: "retiring",
          paths: [],
          reason: "Synthetic startup inspection",
          pending: true,
        });
        const retire = () => {
          recordAgentDatabaseAdmissions([pending], { source: "startup" });
          beginAgentDeletionJournal({
            agentId: "retiring",
            operationId: "retiring-catalog",
            agentDir: state.agentDir("retiring"),
            workspaceDir: state.statePath("workspace-retiring"),
            sessionsDir: state.sessionsDir("retiring"),
            deleteFiles: false,
            phase: "draining",
          });
          expect(readAgentDatabaseAdmissionRefusal("retiring")?.reason).toContain(
            "deleted during startup inspection",
          );
        };
        setList(async ({ sessionEntries }) => {
          if (phase === "delivery") {
            expect(sessionEntries!.entriesForAgent("retiring")).toHaveLength(1);
            retire();
          } else {
            expect(sessionEntries!.entriesForAgent("retiring")).toEqual([]);
            expect(sessionEntries!.entriesForCatalog?.().map((entry) => entry.sessionKey)).toEqual([
              key,
            ]);
          }
          return hosts([
            session(),
            session({ threadId: "retiring-thread", sessionKey: retiringKey }),
          ]);
        });
        if (phase === "planning") {
          retire();
        }
        const response = await list();
        const returned = firstHost(response).sessions;
        expect(returned[0]).toMatchObject({ sessionKey: key, createdActor: original.createdActor });
        expect(returned[1]).not.toHaveProperty("sessionKey");
        expect(returned[1]).not.toHaveProperty("createdActor");
        expect(() => prepareSessionRowSelection(projection, { agentId: "retiring" })).toThrow(
          "deleted during startup inspection",
        );
      },
      { agents: { ownership: "explicit", entries: { main: {}, retiring: {} } } },
    );
  },
);

it("reads clean local catalog entries from the resident owner without SQLite", () =>
  withCatalog(async ({ list, setList }) => {
    const retainedHosts = hosts([session({ pullRequest: { numbers: [1], state: "open" } })]);
    setList(async () => retainedHosts);
    const first = await list();
    expect(payload(first)).toMatchObject({
      catalogs: [{ hosts: [{ sessions: [{ sessionKey: key }] }] }],
    });
    const reads = (["get", "all", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    const second = await list();
    expect(payload(second)).toEqual(payload(first));
    sessionChanges.emit({ all: true, scope: "catalog" });
    expect(payload(await list())).toEqual(payload(first));
    const originalHost = firstHost(first);
    expect(firstHost(second)).toBe(originalHost);
    for (const value of [originalHost, originalHost.sessions, originalHost.sessions[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    for (const read of reads) {
      expect(read).not.toHaveBeenCalled();
    }
    retainedHosts[0]!.label = "Updated provider label";
    retainedHosts[0]!.sessions[0]!.pullRequest!.numbers.push(2);
    const mutatedHost = firstHost(await list());
    expect(mutatedHost).not.toBe(originalHost);
    expectSnapshot(mutatedHost, "Updated provider label", [1, 2]);
    expectSnapshot(originalHost, "Fixture", [1]);
    setList(async () => {
      const freshHosts = hosts([session({ pullRequest: { numbers: [1, 2], state: "open" } })]);
      freshHosts[0]!.label = "Updated provider label";
      return freshHosts;
    });
    expect(firstHost(await list())).toBe(mutatedHost);
    replace({ updatedAt: 2, sessionId: "replacement-instance" });
    const replaced = firstHost(await list());
    expect(replaced).not.toBe(mutatedHost);
    expect(replaced.sessions[0]?.createdActor).toMatchObject(original.createdActor);
    expect(originalHost.sessions[0]?.createdActor).toMatchObject(original.createdActor);
    setList(async () => hosts([session({ name: "Updated provider title" })]));
    const renamed = firstHost(await list());
    expect(renamed).not.toBe(replaced);
    expect(renamed.sessions[0]?.name).toBe("Updated provider title");
    expect(originalHost.sessions[0]?.name).toBeUndefined();
  }));

it("preserves catalog order after row replacement", () =>
  withCatalog(
    async ({ list, setList, projection }) => {
      const snapshots: Array<readonly string[]> = [];
      setList(async ({ sessionEntries }) => {
        snapshots.push(sessionEntries!.entriesForAgent("main").map(({ sessionKey }) => sessionKey));
        return hosts([session()]);
      });
      await list();
      replace({ updatedAt: 2 });
      await list();
      const ordered = prepareSessionRowSelection(
        projection,
        { agentId: "main" },
        { ordered: true },
      );
      expect(ordered.entries("all").map(([sessionKey]) => sessionKey)[0]).toBe(key);
      const unrelated = ["agent:main:unrelated-0", "agent:main:unrelated-1"];
      expect(snapshots).toEqual([
        [key, ...unrelated],
        [...unrelated, key],
      ]);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: unrelated[0]! },
        { sessionId: "unrelated-0", updatedAt: 3, archivedAt: 3 },
      );
      await list();
      expect(snapshots[2]).toEqual([unrelated[1], key, unrelated[0]]);
      expect(snapshots[0]).toEqual([key, ...unrelated]);
    },
    { otherEntryCount: 2 },
  ));

it.each(["planning", "delivery"])(
  "serves catalog %s without draining unrelated display invalidations",
  async (phase) => {
    await withCatalog(
      async ({ list, setList, projection }) => {
        const warm = await list();
        const before = projection.materializedCount;
        const invalidate = () => {
          sessionChanges.emit({ all: true, scope: "catalog" });
          expect(projection.needsMaterialization).toBe(true);
        };
        setList(async ({ sessionEntries }) => {
          expect(sessionEntries?.entriesForCatalog?.()).toHaveLength(41);
          if (phase === "delivery") {
            invalidate();
          }
          return hosts([session()]);
        });
        if (phase === "planning") {
          invalidate();
        }
        const response = await list();
        expect(payload(response)).toEqual(payload(warm));
        expect(projection.materializedCount).toBe(before);
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
      },
      { otherEntryCount: 40 },
    );
  },
);

it("bounds catalog result delivery to returned adoption keys", () =>
  withCatalog(
    async ({ list, setList, projection }) => {
      const selectEntries = projection.selectEntries.bind(projection);
      let deliveryRowsRead = 0;
      setList(async ({ sessionEntries }) => {
        expect(sessionEntries?.entriesForCatalog?.()).toHaveLength(257);
        vi.spyOn(projection, "selectEntries").mockImplementation((query, metadataPrepared) => {
          const rows = selectEntries(query, metadataPrepared);
          deliveryRowsRead += rows.length;
          return rows;
        });
        return hosts([session(), session({ threadId: "blank-key-thread", sessionKey: " " })]);
      });
      const sessions = firstHost(await list()).sessions;
      expect(sessions).toMatchObject([
        { sessionKey: key, createdActor: original.createdActor },
        { threadId: "blank-key-thread" },
      ]);
      expect(sessions[1]).not.toHaveProperty("sessionKey");
      expect(deliveryRowsRead).toBeLessThanOrEqual(1);
    },
    { otherEntryCount: 256 },
  ));

it("bounds roster projections while delivering adopted sessions without an implicit owner", async () => {
  const agentCount = 32;
  const sessionCount = 40;
  let rosterEntryProjections = 0;
  const agents = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [
      index === 0 ? "main" : `agent-${index}`,
      {
        get identity() {
          rosterEntryProjections++;
          return { name: `Agent ${index}` };
        },
      },
    ]),
  );
  await withCatalog(
    async ({ list, setList, projection }) => {
      const keys = Array.from({ length: sessionCount }, (_, i) => `agent:main:adopted-${i}`);
      for (const sessionKey of keys) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...original, sessionId: sessionKey },
        );
      }
      while (projection.needsMaterialization) {
        await projection.ensureMaterialized();
      }
      setList(async ({ sessionEntries }) => {
        expect(sessionEntries?.entriesForCatalog?.()).toHaveLength(sessionCount + 1);
        rosterEntryProjections = 0;
        return hosts(keys.map((sessionKey) => session({ threadId: sessionKey, sessionKey })));
      });
      const sessions = firstHost(await list()).sessions;
      expect(sessions).toHaveLength(sessionCount);
      expect(sessions).toMatchObject(
        keys.map((sessionKey) => ({ sessionKey, createdActor: original.createdActor })),
      );
      expect(rosterEntryProjections).toBeLessThanOrEqual(sessionCount * 8);
    },
    { agents: { ownership: "explicit", entries: agents } },
  );
});

it("does not attach a replacement session identity after provider enumeration yields", () =>
  withCatalog(async ({ list, setList }) => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    setList(async () => {
      started.resolve();
      await release.promise;
      return hosts([session()]);
    });
    const pending = list();
    await started.promise;
    replace({
      sessionId: "replacement-instance",
      updatedAt: 2,
      createdActor: { type: "system", id: "replacement-owner" },
    });
    release.resolve();
    const returnedSession = firstHost(await pending).sessions[0];
    expect(returnedSession).toMatchObject({ threadId: "native-thread" });
    expect(returnedSession).not.toHaveProperty("sessionKey");
    expect(returnedSession).not.toHaveProperty("createdActor");
  }));
