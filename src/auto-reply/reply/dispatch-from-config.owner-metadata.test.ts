import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAcpDatabaseSessionKey } from "../../acp/runtime/session-meta-keys.js";
import * as sessionMeta from "../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as entryReadRuntime from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveSessionStoreLookup } from "./dispatch-from-config.context.js";
import { gatherDispatchRequest } from "./dispatch-from-config.gather.js";
import { prepareDispatchDelivery } from "./dispatch-from-config.prepare-delivery.js";
import * as runtimeLoaders from "./dispatch-from-config.runtime-loaders.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
});

it.each([
  ["read-recovery", {}, true],
  ["lifecycle-change", { lifecycleRevision: "after-gather" }, false],
  ["parent-change", { spawnedBy: undefined }, false],
  ["parent-added", { parentSessionKey: "agent:work:parent" }, true],
  [
    "replacement-parent",
    {
      sessionId: "replacement-child",
      lifecycleRevision: "after-gather",
      spawnedBy: "agent:work:new-parent",
    },
    true,
  ],
  ["metadata-created", {}, true],
  ["metadata-cleared", {}, false],
  ["owner-error", {}, false],
] as const)(
  "keeps explicit-owner ACP metadata current across gather: %s",
  async (scenario, patch, suppressed) => {
    state = await createOpenClawTestState({ label: "dispatch-owner-metadata" });
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, work: {} },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
      session: { scope: "global" },
    };
    await state.writeConfig(cfg);
    const scope = {
      agentId: "work",
      sessionKey: "global",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "work" }),
    };
    const entry = {
      sessionId: "child",
      lifecycleRevision: "before-gather",
      updatedAt: 1,
      spawnedBy: scenario === "parent-added" ? undefined : "agent:work:parent",
    } satisfies SessionEntry;
    replaceSessionEntrySync(scope, entry);
    const replace = (update: Partial<SessionEntry>) =>
      replaceSessionEntrySync(scope, { ...entry, ...update });
    const meta = {
      backend: "acpx",
      agent: "synthetic",
      runtimeSessionName: "canonical-child",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    } as const;
    const writeMeta = (
      lifecycleRevision = entry.lifecycleRevision,
      runtimeSessionName: string = meta.runtimeSessionName,
    ) =>
      sessionMeta.writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey("global", "work"),
        lifecycleRevision,
        meta: { ...meta, runtimeSessionName },
      });
    if (scenario !== "metadata-created") {
      writeMeta();
    }
    if (scenario === "read-recovery") {
      vi.spyOn(entryReadRuntime, "readSessionEntryReadOnlyInWorker").mockRejectedValueOnce(
        new Error("synthetic initial read failure"),
      );
    }
    const loadRuntimePlugins = runtimeLoaders.loadRuntimePlugins;
    vi.spyOn(runtimeLoaders, "loadRuntimePlugins").mockImplementationOnce(async () => {
      await Promise.resolve();
      if (Object.keys(patch).length) {
        replace(patch);
      }
      if (scenario === "replacement-parent") {
        writeMeta("after-gather", "replacement-child");
      }
      if (scenario === "owner-error") {
        cfg.session = { ...cfg.session, store: scope.storePath };
        cfg.agents!.defaults = { ...cfg.agents!.defaults, sessionStore: { agentId: "main" } };
      }
      if (scenario === "metadata-created" || scenario === "metadata-cleared") {
        await sessionMeta.upsertAcpSessionMeta({
          cfg,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          skipMaintenance: true,
          mutate: () => (scenario === "metadata-created" ? meta : null),
        });
      }
      return await loadRuntimePlugins();
    });
    using resources = new DisposableStack();
    const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
    try {
      const gathered = await gatherDispatchRequest(
        {
          cfg,
          ctx: {
            AgentId: "work",
            SessionKey: "global",
            Body: "hello",
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
            CommandAuthorized: false,
          },
          dispatcher,
        },
        undefined,
        false,
        undefined,
        (dispose) => resources.defer(dispose),
      );
      expect(gathered.status).toBe("ready");
      if (gathered.status !== "ready") {
        throw new Error("dispatch gather did not prepare the turn");
      }
      const captured = gathered.state.sessionStoreEntry.entry;
      expect([captured?.acp, captured?.lifecycleRevision]).toEqual([
        undefined,
        scenario === "read-recovery" ? undefined : "before-gather",
      ]);
      if (scenario === "owner-error") {
        await expect(prepareDispatchDelivery(gathered.state)).rejects.toThrow("fixed-store");
        return;
      }
      const prepared = await prepareDispatchDelivery(gathered.state);
      expect(prepared.suppressAcpChildUserDelivery).toBe(suppressed);
    } finally {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  },
);

it("reads the command target in a worker and preserves missing-target lookup facts", async () => {
  state = await createOpenClawTestState({ label: "dispatch-entry-worker" });
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {}, work: {} } },
  };
  await state.writeConfig(cfg);
  const sourceKey = "agent:main:source";
  const targetKey = "agent:work:target";
  for (const [agentId, sessionKey, sessionId] of [
    ["main", sourceKey, "source"],
    ["work", targetKey, "target"],
  ] as const) {
    replaceSessionEntrySync({ agentId, sessionKey }, { sessionId, updatedAt: 1 });
  }
  const ctx = buildTestCtx({ SessionKey: sourceKey, CommandSource: "native" });
  const sql = observeHostDataSql();
  try {
    for (const sessionKey of [targetKey, "agent:work:missing"]) {
      expect(
        await resolveSessionStoreLookup({ ...ctx, CommandTargetSessionKey: sessionKey }, cfg),
      ).toMatchObject({
        agentId: "work",
        sessionKey,
        ...(sessionKey === targetKey
          ? { entry: { sessionId: "target" } }
          : { entry: undefined, store: undefined }),
      });
    }
    expect(
      sql.queries.filter((query) => /\bsession_(?:nodes|windows|participants)\b/.test(query)),
    ).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("does not turn revoked dispatch authority into a missing-entry fallback", async () => {
  const cfg: OpenClawConfig = {};
  const ctx = buildTestCtx({ SessionKey: "agent:main:revoked" });
  const refusal = new Error("dispatch owner retired");
  let current = true;
  vi.spyOn(entryReadRuntime, "readSessionEntryReadOnlyInWorker").mockImplementationOnce(
    async () => {
      await Promise.resolve();
      current = false;
      return { sessionId: "late-entry", updatedAt: 1 };
    },
  );
  await expect(
    resolveSessionStoreLookup(ctx, cfg, () => {
      if (!current) {
        throw refusal;
      }
    }),
  ).rejects.toBe(refusal);
});
