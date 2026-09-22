import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
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
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { sessionCatalogHandlers } from "./session-catalog.js";

afterEach(() => vi.restoreAllMocks());

const key = "agent:main:adopted";
const original = {
  sessionId: "original-instance",
  updatedAt: 1,
  pluginOwnerId: "fixture",
  createdActor: { type: "system" as const, id: "original-owner" },
};

async function withCatalog(
  run: (fixture: {
    list: () => Promise<ReturnType<typeof vi.fn>>;
    setList: (list: SessionCatalogProvider["list"]) => void;
    projection: SessionRowProjection;
  }) => Promise<void>,
  options: { otherEntryCount?: number; agents?: OpenClawConfig["agents"] } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: options.agents ?? {
        list: [{ id: "main", default: true, agentDir: state.agentDir("main") }],
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
    const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg, context });
    bindSessionRowProjection(context, () => projection);
    const previous = captureActivePluginRegistrySnapshot();
    const provider: SessionCatalogProvider = {
      id: "fixture",
      label: "Fixture",
      list: async ({ sessionEntries }) => {
        const adopted = sessionEntries
          ?.entriesForCatalog?.()
          .find((entry) => entry.sessionKey === key);
        return [
          {
            hostId: "gateway:fixture",
            label: "Fixture",
            kind: "gateway",
            connected: true,
            sessions: adopted
              ? [
                  {
                    threadId: "native-thread",
                    sessionKey: key,
                    status: "stored",
                    archived: false,
                    canContinue: true,
                    canArchive: false,
                  },
                ]
              : [],
          },
        ];
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

it("reads clean local catalog entries from the resident owner without SQLite", async () => {
  await withCatalog(async ({ list }) => {
    const first = await list();
    expect(first.mock.calls[0]?.[1]).toMatchObject({
      catalogs: [{ hosts: [{ sessions: [{ sessionKey: key }] }] }],
    });
    const reads = (["get", "all", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    const second = await list();
    expect(second.mock.calls[0]?.[1]).toEqual(first.mock.calls[0]?.[1]);
    expect(
      reads.flatMap((read) =>
        read.mock.contexts.map((statement) =>
          statement instanceof StatementSync ? statement.sourceSQL : "unknown statement",
        ),
      ),
    ).toEqual([]);
  });
});

it("reuses unchanged agent selections across catalog polls and refreshes published rows", async () => {
  await withCatalog(
    async ({ list, setList, projection }) => {
      const workKey = "agent:work:adopted";
      const workEntry = {
        ...original,
        sessionId: "work-instance",
        label: "Work",
        createdActor: { type: "system" as const, id: "work-owner" },
      };
      replaceSessionEntrySync({ agentId: "main", sessionKey: key }, { ...original, label: "Main" });
      replaceSessionEntrySync({ agentId: "work", sessionKey: workKey }, workEntry);
      setList(async ({ sessionEntries }) => [
        {
          hostId: "gateway:fixture",
          label: "Fixture",
          kind: "gateway",
          connected: true,
          sessions: (sessionEntries?.entriesForCatalog?.() ?? []).map(
            ({ agentId, sessionKey, entry }) => ({
              threadId: `${agentId}:${entry.sessionId}`,
              sessionKey,
              title: entry.label,
              status: "stored",
              archived: false,
              canContinue: true,
              canArchive: false,
            }),
          ),
        },
      ]);
      const mainSession = {
        threadId: `main:${original.sessionId}`,
        sessionKey: key,
        title: "Main",
        createdActor: original.createdActor,
      };
      const workSession = {
        threadId: `work:${workEntry.sessionId}`,
        sessionKey: workKey,
        title: "Work",
        createdActor: workEntry.createdActor,
      };
      const first = await list();
      expect(first.mock.calls[0]?.[1]).toMatchObject({
        catalogs: [{ hosts: [{ sessions: [mainSession, workSession] }] }],
      });
      const selectEntries = projection.selectEntries.bind(projection);
      let broadRowsRead = 0;
      vi.spyOn(projection, "selectEntries").mockImplementation((query) => {
        const rows = selectEntries(query);
        if (!query?.key && !query?.sessionIdOrKey) {
          broadRowsRead += rows.length;
        }
        return rows;
      });
      const second = await list();
      expect(second.mock.calls[0]?.[1]).toEqual(first.mock.calls[0]?.[1]);
      expect(broadRowsRead).toBe(0);

      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { ...original, updatedAt: 2, label: "Updated main" },
      );
      const updated = await list();
      expect(updated.mock.calls[0]?.[1]).toMatchObject({
        catalogs: [
          { hosts: [{ sessions: [{ ...mainSession, title: "Updated main" }, workSession] }] },
        ],
      });
      expect(broadRowsRead).toBeGreaterThan(0);
      broadRowsRead = 0;

      const repeated = await list();
      expect(repeated.mock.calls[0]?.[1]).toEqual(updated.mock.calls[0]?.[1]);
      expect(broadRowsRead).toBe(0);
    },
    { agents: { ownership: "explicit", entries: { main: {}, work: {} } } },
  );
});

it("bounds catalog result delivery to returned adoption keys", async () => {
  await withCatalog(
    async ({ list, setList, projection }) => {
      const selectEntries = projection.selectEntries.bind(projection);
      let deliveryRowsRead = 0;
      setList(async ({ sessionEntries }) => {
        expect(sessionEntries?.entriesForCatalog?.()).toHaveLength(257);
        vi.spyOn(projection, "selectEntries").mockImplementation((query) => {
          const rows = selectEntries(query);
          deliveryRowsRead += rows.length;
          return rows;
        });
        return [
          {
            hostId: "gateway:fixture",
            label: "Fixture",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "native-thread",
                sessionKey: key,
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
              {
                threadId: "blank-key-thread",
                sessionKey: " ",
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ];
      });
      const respond = await list();
      const sessions = respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions;
      expect(sessions).toMatchObject([
        { sessionKey: key, createdActor: original.createdActor },
        { threadId: "blank-key-thread" },
      ]);
      expect(sessions[1]).not.toHaveProperty("sessionKey");
      expect(deliveryRowsRead).toBeLessThanOrEqual(1);
    },
    { otherEntryCount: 256 },
  );
});

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
      const keys = Array.from(
        { length: sessionCount },
        (_, index) => `agent:main:adopted-${index}`,
      );
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
        return [
          {
            hostId: "gateway:fixture",
            label: "Fixture",
            kind: "gateway",
            connected: true,
            sessions: keys.map((sessionKey) => ({
              threadId: sessionKey,
              sessionKey,
              status: "stored",
              archived: false,
              canContinue: true,
              canArchive: false,
            })),
          },
        ];
      });
      const respond = await list();
      const sessions = respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions;
      expect(sessions).toHaveLength(sessionCount);
      expect(sessions).toMatchObject(
        keys.map((sessionKey) => ({
          sessionKey,
          createdActor: original.createdActor,
        })),
      );
      expect(rosterEntryProjections).toBeLessThanOrEqual(sessionCount * 8);
    },
    { agents: { ownership: "explicit", entries: agents } },
  );
});

it("does not attach a replacement session identity after provider enumeration yields", async () => {
  await withCatalog(async ({ list, setList }) => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    setList(async ({ sessionEntries }) => {
      expect(
        sessionEntries?.entriesForCatalog?.().find((entry) => entry.sessionKey === key)?.entry
          .sessionId,
      ).toBe(original.sessionId);
      started.resolve();
      await release.promise;
      return [
        {
          hostId: "gateway:fixture",
          label: "Fixture",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "native-thread",
              sessionKey: key,
              status: "stored",
              archived: false,
              canContinue: true,
              canArchive: false,
            },
          ],
        },
      ];
    });
    const pending = list();
    await started.promise;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        ...original,
        sessionId: "replacement-instance",
        updatedAt: 2,
        createdActor: { type: "system", id: "replacement-owner" },
      },
    );
    release.resolve();
    const respond = await pending;
    const session = respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions[0];
    expect(session).toMatchObject({ threadId: "native-thread" });
    expect(session).not.toHaveProperty("sessionKey");
    expect(session).not.toHaveProperty("createdActor");
  });
});
