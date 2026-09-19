import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { listConversations } from "../../config/sessions/conversation-registry.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChatSendCallerContext } from "../../gateway/server-methods/gateway-client-identity.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

describe("dashboard turns retain external conversation identity", () => {
  const tempDirs = createTempDirTracker();
  let stateDir: string;
  let storePath: string;
  let cfg: OpenClawConfig;

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-conversation-kind-");
    storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    cfg = {
      agents: { defaults: { workspace: stateDir } },
      session: { store: storePath, dmScope: "per-channel-peer" },
    };
  });

  afterEach(async () => {
    await cleanupSessionStateForTest({ stateDir });
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });

  it.each([
    { channel: "whatsapp", kind: "group", peerId: "120363000000001@g.us", explicit: false },
    { channel: "discord", kind: "channel", peerId: "123456789", explicit: false },
    { channel: "telegram", kind: "group", peerId: "-100123456789", explicit: false },
    { channel: "whatsapp", kind: "direct", peerId: "+15550000001", explicit: false },
    { channel: "whatsapp", kind: "group", peerId: "120363000000001@g.us", explicit: true },
  ] as const)("keeps $channel $kind identity (explicit route: $explicit)", async (scenario) => {
    const { channel, kind, peerId, explicit } = scenario;
    const sessionKey = `agent:main:${channel}:${kind}:${peerId}`;
    const scope = { agentId: "main", storePath };
    const externalContext = () =>
      finalizeInboundContext(
        buildChannelInboundEventContext({
          channel,
          accountId: "default",
          from: `${channel}:${kind}:${peerId}`,
          sender: { id: "sender-1" },
          conversation: { kind, id: peerId },
          route: { agentId: "main", accountId: "default", routeSessionKey: sessionKey },
          reply: { to: peerId },
          message: { rawBody: "external input" },
        }),
      );
    await initSessionState({ cfg, ctx: externalContext(), commandAuthorized: true });
    const originalEntry = loadSessionEntry({ ...scope, sessionKey });
    const originalConversations = listConversations(scope, { channel });
    expect(originalConversations).toHaveLength(1);
    expect(originalConversations[0]).toMatchObject({ kind, role: "primary", sessionKey });

    const dashboardContext = finalizeInboundContext({
      ...resolveChatSendCallerContext(null, undefined, explicit ? channel : undefined),
      Body: "dashboard input",
      SessionKey: sessionKey,
      ...(explicit
        ? { OriginatingTo: peerId, AccountId: "default", ExplicitDeliverRoute: true }
        : {}),
    });
    expect(dashboardContext.ChatType).toBe("direct");
    await initSessionState({ cfg, ctx: dashboardContext, commandAuthorized: true });
    expect(loadSessionEntry({ ...scope, sessionKey })).toMatchObject({
      sessionId: originalEntry?.sessionId,
      chatType: kind,
      delivery: originalEntry?.delivery,
    });
    expect(listConversations(scope, { channel })).toEqual([
      expect.objectContaining({
        conversationRef: originalConversations[0]?.conversationRef,
        kind,
        role: "primary",
        sessionKey,
      }),
    ]);

    await initSessionState({ cfg, ctx: externalContext(), commandAuthorized: true });
    expect(listConversations(scope, { channel })).toEqual([
      expect.objectContaining({
        conversationRef: originalConversations[0]?.conversationRef,
        kind,
        role: "primary",
      }),
    ]);
  });

  it("creates a direct internal session for a new dashboard conversation", async () => {
    const sessionKey = "agent:main:main";
    await initSessionState({
      cfg,
      ctx: finalizeInboundContext({
        ...resolveChatSendCallerContext(null),
        Body: "new dashboard input",
        SessionKey: sessionKey,
      }),
      commandAuthorized: true,
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      chatType: "direct",
      delivery: { kind: "internal" },
    });
    expect(listConversations({ agentId: "main", storePath })).toEqual([]);
  });
});
