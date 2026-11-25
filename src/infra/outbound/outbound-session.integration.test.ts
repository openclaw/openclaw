import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import {
  listConversations,
  prepareConversationRegistryScope,
  registerConversationAddresses,
  readConversation,
} from "../../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../../config/sessions/conversation-route-fingerprint.js";
import {
  loadExactSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import {
  bindOutboundSessionEntry,
  captureOutboundSessionBinding,
  prepareOutboundSessionBinding,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "./outbound-session.js";
import { routePlugin } from "./outbound-session.test-helpers.js";

function makeRoute(
  sessionKey = "agent:helper:reef:direct:peer",
  id = "peer",
  from = "reef:peer",
  to = "user:peer",
  kind: OutboundSessionRoute["chatType"] = "direct",
): OutboundSessionRoute {
  return { sessionKey, baseSessionKey: sessionKey, peer: { kind, id }, chatType: kind, from, to };
}

function writeEntry(
  scope: Parameters<typeof replaceSessionEntrySync>[0],
  sessionId: string,
  patch: Partial<SessionEntry> = {},
) {
  replaceSessionEntrySync(scope, { sessionId, updatedAt: 100, ...patch });
}

describe("outbound session persistence", () => {
  let storePath: string;

  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-outbound-session-");

  beforeEach(() => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
  });

  const mainScope = () => ({ agentId: "main", storePath });
  const config = (): OpenClawConfig => ({ session: { store: storePath } });
  const entry = (sessionKey: string) => loadExactSessionEntry({ ...mainScope(), sessionKey });
  const conversation = (identity: { conversationRef: string }) =>
    readConversation(mainScope(), identity.conversationRef);
  const seed = (sessionKey: string, overrides: Partial<SessionEntry>) =>
    upsertSessionEntryCore(
      { ...mainScope(), sessionKey },
      {
        sessionId: "shared-main-session",
        updatedAt: 100,
        chatType: "direct",
        ...overrides,
      },
    );
  const bind = (
    route: OutboundSessionRoute,
    workerGuard?: Parameters<typeof bindOutboundSessionEntry>[0]["workerGuard"],
  ) =>
    bindOutboundSessionEntry({
      cfg: config(),
      channel: "reef",
      accountId: "default",
      route,
      workerGuard,
    });
  async function register(
    overrides: Partial<Parameters<typeof buildConversationIdentity>[0]> = {},
    timestamp = 200,
  ) {
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-agent",
      deliveryTarget: "reef:peer-agent",
      nativeDirectUserId: "peer-agent",
      ...overrides,
    });
    expect(identity).not.toBeNull();
    await registerConversationAddresses(mainScope(), [identity!], timestamp);
    return identity!;
  }
  function destination(databaseAgentId = "keeper", filename = "destination.sqlite") {
    const root = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const destinationPath = path.join(root, filename);
    const scope = { agentId: "helper", databaseAgentId, storePath: destinationPath, env };
    const databaseOptions = { agentId: databaseAgentId, path: destinationPath, env };
    return { root, env, destinationPath, scope, databaseOptions };
  }
  async function blockWriter(options: Parameters<typeof runOpenClawAgentWriteAdmission>[0]) {
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = runOpenClawAgentWriteAdmission(options, async () => {
      entered.resolve();
      await release.promise;
    });
    await Promise.race([entered.promise, blocker]);
    return { blocker, release };
  }
  const prepare = (params: Parameters<typeof captureOutboundSessionBinding>[0]) =>
    prepareOutboundSessionBinding(captureOutboundSessionBinding(params));
  const missing = (scope: Parameters<typeof loadSessionEntryReadOnly>[0]) =>
    expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
  const sourceStore = (sourcePath: string, env: NodeJS.ProcessEnv) => ({
    agentId: "source",
    sessionKey: "agent:source:main",
    storePath: sourcePath,
    env,
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([" External ", "internal"])(
    "resolves home paths before carrying only normalized state context (%s)",
    (supervisorMode) => {
      const { root, scope } = destination();
      const captured = captureOutboundSessionBinding({
        cfg: { session: { store: "~/sessions/{agentId}.json" } },
        scope: {
          ...scope,
          env: {
            HOME: root,
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state-root"),
            OPENCLAW_SUPERVISOR_MODE: supervisorMode,
            UNRELATED_BINDING_MARKER: "synthetic",
          },
        },
        sourceSessionKey: "agent:source:main",
      });
      const expected = {
        OPENCLAW_STATE_DIR: path.join(root, "state-root"),
        ...(supervisorMode === " External " ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
      };
      expect([captured.destination.env, captured.source?.env]).toEqual([expected, expected]);
      expect(captured.source?.storePath).toBe(path.join(root, "sessions", "source.json"));
    },
  );

  it("keeps destination and source policy stores separate across asynchronous routing", async () => {
    const { root, env, destinationPath, scope, databaseOptions } = destination();
    openOpenClawAgentDatabase(databaseOptions);
    const actor = { type: "human" as const, source: "profile" as const, id: "creator" };
    const sourceScope = sourceStore(
      path.join(root, "agents", "source", "agent", "openclaw-agent.sqlite"),
      { ...env },
    );
    const sourceSessionKey = sourceScope.sessionKey;
    const provenance = { createdVia: "operator" as const, createdActor: actor };
    writeEntry(sourceScope, "source-before-routing", provenance);
    writeEntry({ ...sourceScope, storePath: destinationPath }, "destination-decoy");
    const cfg: OpenClawConfig = {};
    const prepared = prepare({ cfg, scope, sourceSessionKey });
    const route: OutboundSessionRoute = makeRoute();
    const resolvedRoute = await resolveOutboundSessionRoute({
      cfg,
      channel: "reef",
      agentId: "helper",
      target: "user:peer",
      plugin: routePlugin("reef", async () => {
        await Promise.resolve();
        cfg.session = { store: path.join(root, "changed.sqlite") };
        env.OPENCLAW_STATE_DIR = path.join(root, "changed-state");
        vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
        writeEntry(sourceScope, "source-after-routing", {
          updatedAt: 101,
          ...provenance,
          sandbox: "required",
        });
        return route;
      }),
    });
    expect(resolvedRoute).toEqual(route);

    await bindOutboundSessionEntry({ cfg, channel: "reef", route, sourceSessionKey }, prepared);

    const persisted = loadSessionEntryReadOnly({
      ...prepared.destination,
      sessionKey: route.sessionKey,
    });
    expect(persisted).toMatchObject({ sandbox: "required", ...provenance });
    expect(deliveryContextFromSession(persisted)).toMatchObject({
      channel: "reef",
      to: "user:peer",
    });
    missing({ ...sourceScope, sessionKey: route.sessionKey });
    missing({ agentId: "helper", sessionKey: route.sessionKey, storePath: cfg.session?.store });
  });

  it.each([false, true])(
    "rechecks route authority after its captured writer queue waits (revoked: %s)",
    async (revoked) => {
      const { scope, databaseOptions } = destination();
      openOpenClawAgentDatabase(databaseOptions);
      const route: OutboundSessionRoute = makeRoute();
      const read = () => loadSessionEntryReadOnly({ ...scope, sessionKey: route.sessionKey });
      writeEntry({ ...scope, sessionKey: route.sessionKey }, "retained");
      const prepared = prepare({ cfg: {}, scope });
      const { blocker, release } = await blockWriter(databaseOptions);
      let allowed = true;
      const refusal = new Error("route owner changed");
      const pending = bindOutboundSessionEntry(
        {
          cfg: {},
          channel: "reef",
          route,
          workerGuard: {
            assertMutationAllowed: () => {
              if (!allowed) {
                throw refusal;
              }
            },
          },
        },
        prepared,
      );
      const result = revoked
        ? expect(pending).rejects.toBe(refusal)
        : expect(pending).resolves.toBeUndefined();
      try {
        expect(deliveryContextFromSession(read())).toBeUndefined();
        allowed = !revoked;
      } finally {
        release.resolve();
        await blocker;
        await result;
      }
      const persisted = read();
      expect(persisted).toMatchObject({ updatedAt: 100, sessionId: "retained" });
      if (revoked) {
        expect(deliveryContextFromSession(persisted)).toBeUndefined();
      } else {
        expect(deliveryContextFromSession(persisted)).toMatchObject({
          channel: "reef",
          to: "user:peer",
        });
      }
    },
  );

  it("refuses a replacement physical source owner with the same logical session", async () => {
    const { root, env, scope: target } = destination("destination-owner", "helper.sqlite");
    const cfg: OpenClawConfig = { session: { store: path.join(root, "{agentId}.sqlite") } };
    const sourcePath = path.join(root, "source.sqlite");
    const sourceScope = sourceStore(sourcePath, env);
    openOpenClawAgentDatabase({ agentId: "source-owner", path: sourcePath, env });
    writeEntry(sourceScope, "same-session", { sandbox: "required" });
    const prepared = prepare({ cfg, scope: target, sourceSessionKey: sourceScope.sessionKey });
    expect(await disposeOpenClawAgentDatabaseByPath(sourcePath, { env })).toBe(true);
    fs.renameSync(sourcePath, path.join(root, "retired-source.sqlite"));
    openOpenClawAgentDatabase({ agentId: "replacement", path: sourcePath, env });
    writeEntry(sourceScope, "same-session");
    const route: OutboundSessionRoute = makeRoute();

    await expect(
      bindOutboundSessionEntry(
        { cfg, channel: "reef", route, sourceSessionKey: sourceScope.sessionKey },
        prepared,
      ),
    ).rejects.toThrow("belongs to agent replacement; requested agent source-owner");
    missing({ ...target, sessionKey: route.sessionKey });
  });

  it("refuses a foreign address change while the binding waits for its writer", async () => {
    const cfg = config();
    const identity = await register(
      { peerId: "peer", deliveryTarget: "user:peer", nativeDirectUserId: undefined },
      Date.now(),
    );
    const scope = await prepareConversationRegistryScope({ agentId: "main", config: cfg });
    const discovered = (await readConversation(scope, identity.conversationRef))!;
    const prepared = prepare({ cfg, scope });
    const { blocker, release } = await blockWriter({
      agentId: scope.databaseAgentId,
      path: scope.storePath,
      env: scope.env,
    });
    const sessionKey = "agent:main:reef:direct:peer";
    const pending = bindOutboundSessionEntry(
      {
        cfg,
        channel: "reef",
        route: makeRoute(sessionKey, "peer", "reef:peer", identity.deliveryTarget),
        workerGuard: {
          conversation: {
            conversationRef: identity.conversationRef,
            expectedRouteFingerprint: resolveConversationRouteFingerprint(discovered),
          },
        },
      },
      prepared,
    );
    const outcome = expect(pending).rejects.toThrow("Conversation is no longer available");
    try {
      const { DatabaseSync } = requireNodeSqlite();
      const foreign = new DatabaseSync(scope.storePath);
      try {
        foreign
          .prepare("UPDATE conversations SET delivery_target = ? WHERE conversation_id = ?")
          .run("user:changed", identity.conversationRef);
      } finally {
        foreign.close();
      }
    } finally {
      release.resolve();
      await blocker;
      await outcome;
    }
    missing({ ...scope, sessionKey });
    expect((await readConversation(scope, identity.conversationRef))?.target).toBe("user:changed");
  });

  it.each([
    ["existing alias", "agent:main:main", "@molty", "discord"],
    ["newer threadless address", "agent:main:main", "reef:peer-agent", "reef"],
    ["missing peer", "agent:main:reef:direct:peer-agent", "reef:peer-agent", false],
  ] as const)(
    "binds a discovered %s to its session",
    async (_name, sessionKey, target, previousChannel) => {
      const existing = Boolean(previousChannel);
      if (previousChannel) {
        const oldTarget = previousChannel === "reef" ? target : "user:operator";
        await seed(sessionKey, {
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: previousChannel,
              accountId: "default",
              to: oldTarget,
              threadId: "old-thread",
            },
            origin: {
              provider: previousChannel,
              accountId: "default",
              chatType: "direct",
              from: `${previousChannel}:peer-agent`,
              to: oldTarget,
              threadId: "old-thread",
            },
          }),
        });
      }
      const identity = await register(
        { deliveryTarget: target },
        existing ? entry(sessionKey)!.entry.updatedAt + 1 : 200,
      );
      const discovered = (await listConversations(mainScope(), { channel: "reef" }))[0];
      expect(discovered?.conversationRef).toBe(identity.conversationRef);
      expect(discovered).not.toMatchObject({ sessionId: expect.any(String) });
      const guarded = previousChannel === "discord";
      const workerGuard = guarded
        ? {
            conversation: {
              conversationRef: identity.conversationRef,
              expectedRouteFingerprint: resolveConversationRouteFingerprint(discovered!),
            },
          }
        : undefined;
      const sql = guarded ? observeHostDataSql() : undefined;
      try {
        await bind(makeRoute(sessionKey, "peer-agent", "reef:peer-agent", target), workerGuard);
        if (sql) {
          const queries = sql.queries.filter((query) =>
            /\b(?:conversations|session_conversations)\b/i.test(query),
          );
          expect(queries).toEqual([]);
        }
      } finally {
        sql?.restore();
      }
      expect(await conversation(identity)).toMatchObject({
        sessionId: existing ? "shared-main-session" : expect.any(String),
        sessionKey,
        role: existing ? "participant" : "primary",
        target,
      });
      const persisted = entry(sessionKey)?.entry;
      expect(deliveryContextFromSession(persisted)?.threadId).toBeUndefined();
      expect(sessionDeliveryOrigin(persisted)?.threadId).toBeUndefined();
    },
  );

  it("persists a group ingress origin without rewriting its native channel target", async () => {
    const channelId = "private-room-123";
    const sessionKey = `agent:main:reef:group:${channelId}`;
    const from = `reef:group:${channelId}`;
    const to = `channel:${channelId}`;
    const identity = await register({
      kind: "group",
      peerId: from,
      deliveryTarget: to,
      nativeChannelId: channelId,
      nativeDirectUserId: undefined,
    });

    await bind(makeRoute(sessionKey, channelId, from, to, "group"));

    const persisted = entry(sessionKey);
    expect(sessionDeliveryOrigin(persisted?.entry)).toMatchObject({
      provider: "reef",
      accountId: "default",
      from,
    });
    expect(await conversation(identity)).toMatchObject({
      kind: "group",
      nativeChannelId: channelId,
      sessionKey,
      target: to,
    });
  });

  it("preserves an existing group title for a directory identifier fallback", async () => {
    const cfg: OpenClawConfig = { session: { store: storePath, groupScope: "per-group" } };
    const roomId = "8f560ffb-37e2-4078-a6c4-83e4d72e94b3";
    const plugin = routePlugin("directory-chat", () =>
      makeRoute(
        `agent:main:directory-chat:group:${roomId}`,
        roomId,
        `directory-chat:group:${roomId}`,
        `group:${roomId}`,
        "group",
      ),
    );
    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "directory-chat",
      plugin,
      agentId: "main",
      target: `group:${roomId}`,
      resolvedTarget: {
        to: `group:${roomId}`,
        kind: "group",
        display: roomId,
        source: "directory",
        resolutionSource: "directory",
      },
    });
    expect(route).toBeDefined();
    if (!route) {
      return;
    }
    expect(route.displayName).toBeUndefined();
    await seed(route.sessionKey, {
      sessionId: "existing-directory-group",
      chatType: "group",
      subject: "Family",
    });

    await bindOutboundSessionEntry({ cfg, channel: "directory-chat", route });

    const persisted = entry(route.sessionKey);
    expect(persisted?.entry.subject).toBe("Family");
    expect(persisted?.entry.displayName).not.toContain(roomId);
  });
});
