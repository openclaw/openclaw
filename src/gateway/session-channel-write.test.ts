import { expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSessionTargetPolicyAuthorizer } from "./session-sharing-authorization.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";
import { roleClient, rolePolicyConfig, sharingPolicyTarget } from "./session-sharing.test-utils.js";

const sessionKey = "agent:main:telegram:group:-100123450001:topic:7641";
const creatorId = "telegram-group-creator";

function groupTarget(access?: SessionEntry["access"]): ReturnType<typeof sharingPolicyTarget> {
  const target = sharingPolicyTarget({ type: "human", id: creatorId });
  target.canonicalKey = sessionKey;
  target.storeKey = sessionKey;
  target.storeKeys = [sessionKey];
  target.entry = {
    sessionId: "telegram-group-session",
    updatedAt: 1,
    createdVia: "channel",
    ...(access ? { access } : {}),
    delivery: {
      kind: "external",
      route: {
        channel: "telegram",
        accountId: "default",
        target: { to: "telegram:-100123450001:topic:7641" },
        thread: { id: "7641" },
      },
      context: {},
      origin: {
        provider: "telegram",
        chatType: "group",
        nativeChannelId: "-100123450001:topic:7641",
      },
    },
  };
  return target;
}

function authorize(params: {
  method: "chat.send" | "sessions.send";
  channelMember: boolean;
  scopes?: string[];
  access?: SessionEntry["access"];
  visibility?: SessionEntry["visibility"];
  incognito?: boolean;
  requireOwner?: boolean;
}) {
  const cfg = rolePolicyConfig();
  const client = roleClient("none", `channel-writer-${params.method}-${params.channelMember}`);
  client.connect.scopes = params.scopes ?? ["operator.read", "operator.write"];
  const target = groupTarget(params.access);
  target.entry.visibility = params.visibility ?? "shared";
  if (params.incognito) {
    target.entry.incognito = true;
  }
  const policy = prepareProjectedSessionSharing({
    cfg,
    client,
    isMember: () => false,
    channelRead: () => params.channelMember,
  });
  const authorizeTarget = createSessionTargetPolicyAuthorizer({
    params: {
      client,
      method: params.method,
      requestParams: params.method === "chat.send" ? { sessionKey } : { key: sessionKey },
      context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    },
    authorizesAgentRun: true,
    authorizesRead: false,
    targetOwnership: { requireOwner: params.requireOwner ?? false },
    sessionCap: () => policy.sessionCap,
    resolveMembership: () => false,
  });
  return authorizeTarget({ sessionKey, agentId: "main" }, target, cfg, policy);
}

it.each(["chat.send", "sessions.send"] as const)(
  "%s allows only a verified Telegram group member under sessions.others=none",
  (method) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      expect(authorize({ method, channelMember: true, visibility: "shared" })).toBeNull();
      expect(authorize({ method, channelMember: true, visibility: "read-only" })).not.toBeNull();
      expect(authorize({ method, channelMember: true, visibility: "suggest" })).not.toBeNull();
      expect(authorize({ method, channelMember: false })).not.toBeNull();
      expect(
        authorize({
          method,
          channelMember: true,
          access: { mode: "creator" },
        }),
      ).not.toBeNull();
      expect(authorize({ method, channelMember: true, visibility: "draft" })).not.toBeNull();
      expect(authorize({ method, channelMember: true, incognito: true })).not.toBeNull();
      expect(authorize({ method, channelMember: true, requireOwner: true })).not.toBeNull();
      expect(authorize({ method, channelMember: true, scopes: ["operator.read"] })).not.toBeNull();
    }),
);
