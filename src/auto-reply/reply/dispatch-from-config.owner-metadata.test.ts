import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAcpDatabaseSessionKey } from "../../acp/runtime/session-meta-keys.js";
import * as sessionMeta from "../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as entryReadRuntime from "../../config/sessions/session-entry-read-runtime.js";
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
  "read-recovery",
  "lifecycle-change",
  "parent-change",
  "replacement-parent",
  "owner-error",
] as const)("keeps explicit-owner ACP metadata current across gather: %s", async (scenario) => {
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
    spawnedBy: "agent:work:parent",
  };
  replaceSessionEntrySync(scope, entry);
  const meta = {
    backend: "acpx",
    agent: "synthetic",
    runtimeSessionName: "canonical-child",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 1,
  } as const;
  sessionMeta.writeAcpSessionMetaForMigration({
    sessionKey: buildAcpDatabaseSessionKey("global", "work"),
    lifecycleRevision: entry.lifecycleRevision,
    meta,
  });
  if (scenario === "read-recovery") {
    vi.spyOn(entryReadRuntime, "readSessionEntryReadOnlyInWorker").mockRejectedValueOnce(
      new Error("synthetic initial read failure"),
    );
  }
  const loadRuntimePlugins = runtimeLoaders.loadRuntimePlugins;
  vi.spyOn(runtimeLoaders, "loadRuntimePlugins").mockImplementationOnce(async () => {
    await Promise.resolve();
    if (scenario === "lifecycle-change") {
      replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "after-gather" });
    }
    if (scenario === "replacement-parent") {
      replaceSessionEntrySync(scope, {
        ...entry,
        sessionId: "replacement-child",
        lifecycleRevision: "after-gather",
        spawnedBy: "agent:work:new-parent",
      });
      sessionMeta.writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey("global", "work"),
        lifecycleRevision: "after-gather",
        meta: { ...meta, runtimeSessionName: "replacement-child" },
      });
    }
    if (scenario === "owner-error") {
      cfg.session = { ...cfg.session, store: scope.storePath };
      cfg.agents!.defaults = { ...cfg.agents!.defaults, sessionStore: { agentId: "main" } };
    }
    if (scenario === "parent-change") {
      replaceSessionEntrySync(scope, { ...entry, spawnedBy: undefined });
    }
    return await loadRuntimePlugins();
  });
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
    );
    expect(gathered.status).toBe("ready");
    if (gathered.status !== "ready") {
      throw new Error("dispatch gather did not prepare the turn");
    }
    // Canonical ACP metadata is deliberately absent from the captured session row.
    expect(gathered.state.sessionStoreEntry.entry?.acp).toBeUndefined();
    expect(gathered.state.sessionStoreEntry.entry?.lifecycleRevision).toBe(
      scenario === "read-recovery" ? undefined : "before-gather",
    );
    if (scenario === "owner-error") {
      await expect(prepareDispatchDelivery(gathered.state)).rejects.toThrow("fixed-store");
      return;
    }
    const prepared = await prepareDispatchDelivery(gathered.state);
    expect(prepared.state.suppressAcpChildUserDelivery).toBe(
      scenario === "read-recovery" || scenario === "replacement-parent",
    );
  } finally {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
});

it("reads the command target in a worker and preserves missing-target lookup facts", async () => {
  state = await createOpenClawTestState({ label: "dispatch-entry-worker" });
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {}, work: {} } },
  };
  await state.writeConfig(cfg);
  const sourceKey = "agent:main:source";
  const targetKey = "agent:work:target";
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: sourceKey },
    { sessionId: "source", updatedAt: 1 },
  );
  replaceSessionEntrySync(
    { agentId: "work", sessionKey: targetKey },
    { sessionId: "target", updatedAt: 1 },
  );
  const ctx = buildTestCtx({
    SessionKey: sourceKey,
    CommandTargetSessionKey: targetKey,
    CommandSource: "native",
  });
  const sql = observeHostDataSql();
  try {
    expect(await resolveSessionStoreLookup(ctx, cfg)).toMatchObject({
      agentId: "work",
      sessionKey: targetKey,
      entry: { sessionId: "target" },
    });
    expect(
      await resolveSessionStoreLookup(
        { ...ctx, CommandTargetSessionKey: "agent:work:missing" },
        cfg,
      ),
    ).toMatchObject({
      agentId: "work",
      sessionKey: "agent:work:missing",
      entry: undefined,
      store: undefined,
    });
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
