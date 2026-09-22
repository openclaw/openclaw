import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  resolveConversation,
} from "../../config/sessions/conversation-registry.js";
import {
  loadExactSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import {
  bindOutboundSessionEntry,
  captureOutboundSessionBinding,
  prepareOutboundSessionBinding,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "./outbound-session.js";

describe("outbound session persistence", () => {
  let storePath: string;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-outbound-session-"), "sessions.json");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([" External ", "internal"])(
    "resolves home paths before carrying only normalized state context (%s)",
    (supervisorMode) => {
      const root = tempDirs.make("openclaw-outbound-binding-context-");
      const captured = captureOutboundSessionBinding({
        cfg: { session: { store: "~/sessions/{agentId}.json" } },
        scope: {
          agentId: "helper",
          databaseAgentId: "keeper",
          storePath: path.join(root, "destination.sqlite"),
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
      expect(captured.destination.env).toEqual(expected);
      expect(captured.source?.env).toEqual(expected);
      expect(captured.source?.storePath).toBe(path.join(root, "sessions", "source.json"));
    },
  );

  it("keeps destination and source policy stores separate across asynchronous routing", async () => {
    const root = tempDirs.make("openclaw-outbound-binding-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const destinationPath = path.join(root, "destination.sqlite");
    openOpenClawAgentDatabase({ agentId: "keeper", path: destinationPath, env });
    const actor = { type: "human" as const, source: "profile" as const, id: "creator" };
    const sourceSessionKey = "agent:source:main";
    const sourceScope = {
      agentId: "source",
      sessionKey: sourceSessionKey,
      storePath: path.join(root, "agents", "source", "agent", "openclaw-agent.sqlite"),
      env: { ...env },
    };
    replaceSessionEntrySync(sourceScope, {
      sessionId: "source-before-routing",
      updatedAt: 100,
      createdVia: "operator",
      createdActor: actor,
    });
    replaceSessionEntrySync(
      { ...sourceScope, storePath: destinationPath },
      { sessionId: "destination-decoy", updatedAt: 100 },
    );
    const cfg: OpenClawConfig = {};
    const prepared = prepareOutboundSessionBinding(
      captureOutboundSessionBinding({
        cfg,
        scope: { agentId: "helper", databaseAgentId: "keeper", storePath: destinationPath, env },
        sourceSessionKey,
      }),
    );
    const route: OutboundSessionRoute = {
      sessionKey: "agent:helper:reef:direct:peer",
      baseSessionKey: "agent:helper:reef:direct:peer",
      peer: { kind: "direct", id: "peer" },
      chatType: "direct",
      from: "reef:peer",
      to: "user:peer",
    };
    const resolvedRoute = await resolveOutboundSessionRoute({
      cfg,
      channel: "reef",
      agentId: "helper",
      target: "user:peer",
      plugin: {
        ...createChannelTestPluginBase({ id: "reef" }),
        messaging: {
          resolveOutboundSessionRoute: async () => {
            await Promise.resolve();
            cfg.session = { store: path.join(root, "changed.sqlite") };
            env.OPENCLAW_STATE_DIR = path.join(root, "changed-state");
            vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
            replaceSessionEntrySync(sourceScope, {
              sessionId: "source-after-routing",
              updatedAt: 101,
              createdVia: "operator",
              createdActor: actor,
              sandbox: "required",
            });
            return route;
          },
        },
      },
    });
    expect(resolvedRoute).toEqual(route);

    await bindOutboundSessionEntry({ cfg, channel: "reef", route, sourceSessionKey }, prepared);

    const persisted = loadSessionEntryReadOnly({
      ...prepared.destination,
      sessionKey: route.sessionKey,
    });
    expect(persisted).toMatchObject({
      sandbox: "required",
      createdVia: "operator",
      createdActor: actor,
    });
    expect(deliveryContextFromSession(persisted)).toMatchObject({
      channel: "reef",
      to: "user:peer",
    });
    expect(
      loadSessionEntryReadOnly({ ...sourceScope, sessionKey: route.sessionKey }),
    ).toBeUndefined();
    expect(
      loadSessionEntryReadOnly({
        agentId: "helper",
        sessionKey: route.sessionKey,
        storePath: cfg.session?.store,
      }),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "rechecks route authority after its captured writer queue waits (revoked: %s)",
    async (revoked) => {
      const root = tempDirs.make("openclaw-outbound-binding-queue-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: root };
      const destinationPath = path.join(root, "destination.sqlite");
      const scope = {
        agentId: "helper",
        databaseAgentId: "keeper",
        storePath: destinationPath,
        env,
      };
      const databaseOptions = { agentId: "keeper", path: destinationPath, env };
      openOpenClawAgentDatabase(databaseOptions);
      const route: OutboundSessionRoute = {
        sessionKey: "agent:helper:reef:direct:peer",
        baseSessionKey: "agent:helper:reef:direct:peer",
        peer: { kind: "direct", id: "peer" },
        chatType: "direct",
        from: "reef:peer",
        to: "user:peer",
      };
      replaceSessionEntrySync(
        { ...scope, sessionKey: route.sessionKey },
        { sessionId: "retained", updatedAt: 100 },
      );
      const prepared = prepareOutboundSessionBinding(
        captureOutboundSessionBinding({ cfg: {}, scope }),
      );
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = runOpenClawAgentWriteAdmission(databaseOptions, async () => {
        entered.resolve();
        await release.promise;
      });
      await Promise.race([entered.promise, blocker]);
      let allowed = true;
      const refusal = new Error("route owner changed");
      const pending = bindOutboundSessionEntry(
        {
          cfg: {},
          channel: "reef",
          route,
          assertCommitAllowed: () => {
            if (!allowed) {
              throw refusal;
            }
          },
        },
        prepared,
      );
      const result = revoked
        ? expect(pending).rejects.toBe(refusal)
        : expect(pending).resolves.toBeUndefined();
      try {
        expect(
          deliveryContextFromSession(
            loadSessionEntryReadOnly({ ...scope, sessionKey: route.sessionKey }),
          ),
        ).toBeUndefined();
        allowed = !revoked;
      } finally {
        release.resolve();
        await blocker;
        await result;
      }
      const persisted = loadSessionEntryReadOnly({ ...scope, sessionKey: route.sessionKey });
      expect(persisted?.updatedAt).toBe(100);
      expect(persisted?.sessionId).toBe("retained");
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
    const root = tempDirs.make("openclaw-outbound-source-owner-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const cfg: OpenClawConfig = { session: { store: path.join(root, "{agentId}.sqlite") } };
    const sourcePath = path.join(root, "source.sqlite");
    const sourceScope = {
      agentId: "source",
      sessionKey: "agent:source:main",
      storePath: sourcePath,
      env,
    };
    openOpenClawAgentDatabase({ agentId: "source-owner", path: sourcePath, env });
    replaceSessionEntrySync(sourceScope, {
      sessionId: "same-session",
      updatedAt: 100,
      sandbox: "required",
    });
    const destination = {
      agentId: "helper",
      databaseAgentId: "destination-owner",
      storePath: path.join(root, "helper.sqlite"),
      env,
    };
    const prepared = prepareOutboundSessionBinding(
      captureOutboundSessionBinding({
        cfg,
        scope: destination,
        sourceSessionKey: sourceScope.sessionKey,
      }),
    );
    expect(disposeOpenClawAgentDatabaseByPath(sourcePath, { env })).toBe(true);
    fs.renameSync(sourcePath, path.join(root, "retired-source.sqlite"));
    openOpenClawAgentDatabase({ agentId: "replacement", path: sourcePath, env });
    replaceSessionEntrySync(sourceScope, { sessionId: "same-session", updatedAt: 100 });
    const route: OutboundSessionRoute = {
      sessionKey: "agent:helper:reef:direct:peer",
      baseSessionKey: "agent:helper:reef:direct:peer",
      peer: { kind: "direct", id: "peer" },
      chatType: "direct",
      from: "reef:peer",
      to: "user:peer",
    };

    await expect(
      bindOutboundSessionEntry(
        { cfg, channel: "reef", route, sourceSessionKey: sourceScope.sessionKey },
        prepared,
      ),
    ).rejects.toThrow("belongs to agent replacement; requested agent source-owner");
    expect(
      loadSessionEntryReadOnly({ ...destination, sessionKey: route.sessionKey }),
    ).toBeUndefined();
  });

  it("binds a discovered canonical peer through a different delivery alias", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "shared-main-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", accountId: "default", to: "user:operator" },
          origin: { provider: "discord", accountId: "default", from: "discord:operator" },
        }),
      },
    );
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-agent",
      deliveryTarget: "@molty",
      nativeDirectUserId: "peer-agent",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 200);
    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).not.toMatchObject({ sessionId: expect.any(String) });

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "direct", id: "peer-agent" },
        chatType: "direct",
        from: "reef:peer-agent",
        to: "@molty",
      },
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).toMatchObject({
      sessionId: "shared-main-session",
      sessionKey,
      role: "participant",
      target: "@molty",
    });
  });

  it("binds a newer threadless address without restoring the established thread", async () => {
    const sessionKey = "agent:main:main";
    const peerId = "reef:contact-42";
    const target = "reef:contact-42";
    const threadId = "thread-7";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "shared-main-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "reef", accountId: "default", to: target, threadId },
          origin: {
            provider: "reef",
            accountId: "default",
            chatType: "direct",
            from: peerId,
            to: target,
            threadId,
          },
        }),
      },
    );
    const threadlessIdentity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId,
      deliveryTarget: target,
      nativeDirectUserId: "contact-42",
    });
    expect(threadlessIdentity).toBeDefined();
    const established = loadExactSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(established).toBeDefined();
    registerConversationAddresses(
      { agentId: "main", storePath },
      [threadlessIdentity!],
      established!.entry.updatedAt + 1,
    );

    const discovered = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(discovered[0]?.conversationRef).toBe(threadlessIdentity!.conversationRef);
    expect(discovered[0]).not.toMatchObject({ sessionId: expect.any(String) });

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "direct", id: "contact-42" },
        chatType: "direct",
        from: peerId,
        to: target,
      },
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, threadlessIdentity!.conversationRef),
    ).toMatchObject({
      sessionId: "shared-main-session",
      sessionKey,
      role: "participant",
      target,
    });
    const persisted = loadExactSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(deliveryContextFromSession(persisted?.entry)?.threadId).toBeUndefined();
    expect(sessionDeliveryOrigin(persisted?.entry)?.threadId).toBeUndefined();
  });

  it("creates the session row when a discovered peer has no local entry", async () => {
    const sessionKey = "agent:main:reef:direct:peer-agent";
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-agent",
      deliveryTarget: "reef:peer-agent",
      nativeDirectUserId: "peer-agent",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 200);
    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).not.toMatchObject({ sessionId: expect.any(String) });

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "direct", id: "peer-agent" },
        chatType: "direct",
        from: "reef:peer-agent",
        to: "reef:peer-agent",
      },
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).toMatchObject({
      sessionId: expect.any(String),
      sessionKey,
      role: "primary",
      target: "reef:peer-agent",
    });
  });

  it("persists a group ingress origin without rewriting its native channel target", async () => {
    const channelId = "private-room-123";
    const sessionKey = `agent:main:reef:group:${channelId}`;
    const from = `reef:group:${channelId}`;
    const to = `channel:${channelId}`;
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "group",
      peerId: from,
      deliveryTarget: to,
      nativeChannelId: channelId,
    });
    expect(identity).not.toBeNull();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 200);

    await bindOutboundSessionEntry({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      channel: "reef",
      accountId: "default",
      route: {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: "group", id: channelId },
        chatType: "group",
        from,
        to,
      },
    });

    const persisted = loadExactSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(sessionDeliveryOrigin(persisted?.entry)).toMatchObject({
      provider: "reef",
      accountId: "default",
      from,
    });
    expect(
      resolveConversation({ agentId: "main", storePath }, identity!.conversationRef),
    ).toMatchObject({
      kind: "group",
      nativeChannelId: channelId,
      sessionKey,
      target: to,
    });
  });

  it("preserves an existing group title for a directory identifier fallback", async () => {
    const cfg = {
      session: { store: storePath, groupScope: "per-group" },
    } as OpenClawConfig;
    const roomId = "8f560ffb-37e2-4078-a6c4-83e4d72e94b3";
    const plugin = {
      ...createChannelTestPluginBase({ id: "directory-chat" }),
      messaging: {
        resolveOutboundSessionRoute: () => ({
          sessionKey: `agent:main:directory-chat:group:${roomId}`,
          baseSessionKey: `agent:main:directory-chat:group:${roomId}`,
          peer: { kind: "group" as const, id: roomId },
          chatType: "group" as const,
          from: `directory-chat:group:${roomId}`,
          to: `group:${roomId}`,
        }),
      },
    } satisfies ChannelPlugin;
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
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: route.sessionKey, storePath },
      {
        sessionId: "existing-directory-group",
        updatedAt: 100,
        chatType: "group",
        subject: "Family",
      },
    );

    await bindOutboundSessionEntry({ cfg, channel: "directory-chat", route });

    const persisted = loadExactSessionEntry({
      agentId: "main",
      sessionKey: route.sessionKey,
      storePath,
    });
    expect(persisted?.entry.subject).toBe("Family");
    expect(persisted?.entry.displayName).not.toContain(roomId);
  });
});
