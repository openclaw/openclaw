import { expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { prepareSessionSharing } from "./session-sharing-read.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

it("adds verified group reads without widening private ACLs or narrowing existing role grants", () => {
  const key = "agent:main:telegram:group:-123456";
  const entry: SessionEntry = {
    sessionId: "channel-sharing",
    updatedAt: 1,
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "777" },
    delivery: {
      kind: "external",
      route: { channel: "telegram", accountId: "default", target: { to: "telegram:-123456" } },
      context: {},
      origin: { provider: "telegram", chatType: "group", nativeChannelId: "-123456" },
    },
  };
  const target = {
    agentId: "main",
    canonicalKey: key,
    storeKey: key,
    storeKeys: [key],
    storePath: "/fixture",
    entry,
  };
  const client = sharingPolicyClient({ user: "viewer" });
  const prepared = {
    aliases: new Set(["viewer"]),
    sessionCap: "none" as const,
    isMember: () => false,
  };
  expect(prepareSessionSharing({ cfg: {}, client }, prepared).canReadTarget(target)).toBe(false);
  expect(
    prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => false },
    ).canReadTarget(target),
  ).toBe(false);
  expect(
    prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => true },
    ).canReadTarget(target),
  ).toBe(true);
  expect(
    prepareSessionSharing({ cfg: {}, client }, { ...prepared, sessionCap: "write" }).canReadTarget(
      target,
    ),
  ).toBe(true);
  const privateTarget = { ...target, entry: { ...entry, access: { mode: "creator" as const } } };
  expect(
    prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => true },
    ).canReadTarget(privateTarget),
  ).toBe(false);
});

it("keeps verified membership behind the current source-audience ACL", () => {
  const key = "agent:main:telegram:group:-123456";
  const entry: SessionEntry = {
    sessionId: "channel-sharing-source-acl",
    updatedAt: 1,
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "777" },
    delivery: {
      kind: "external",
      route: { channel: "telegram", accountId: "default", target: { to: "telegram:-123456" } },
      context: {},
      origin: { provider: "telegram", chatType: "group", nativeChannelId: "-123456" },
    },
  };
  const target = {
    agentId: "main",
    canonicalKey: key,
    storeKey: key,
    storeKeys: [key],
    storePath: "/fixture",
    entry,
  };
  const client = sharingPolicyClient({ user: "viewer" });
  const prepared = {
    aliases: new Set(["viewer"]),
    sessionCap: "none" as const,
    isMember: () => false,
  };
  const sourceTarget = {
    ...target,
    entry: { ...entry, access: { mode: "source" as const } },
  };
  const membership = { ...prepared, channelRead: () => true };
  const accessConfig = (profileIds: string[]) => ({
    session: {
      sharing: {
        accessPolicy: {
          default: "creator" as const,
          groups: [
            {
              agentId: "main",
              channel: "telegram",
              peerId: "-123456",
              profileIds,
            },
          ],
        },
      },
    },
  });
  const canRead = (cfg: Parameters<typeof prepareSessionSharing>[0]["cfg"]) =>
    prepareSessionSharing({ cfg, client }, membership).canReadTarget(sourceTarget);
  const canReadDirect = (cfg: Parameters<typeof prepareSessionSharing>[0]["cfg"]) =>
    prepareSessionSharing({ cfg, client }, membership).canReadDirectTarget(sourceTarget);

  expect(canRead(accessConfig(["viewer"]))).toBe(true);
  expect(canReadDirect(accessConfig(["viewer"]))).toBe(true);
  expect(canRead(accessConfig(["another-profile"]))).toBe(false);
  expect(canReadDirect(accessConfig(["another-profile"]))).toBe(false);
  expect(canRead({})).toBe(false);
  expect(canReadDirect({})).toBe(false);
});
