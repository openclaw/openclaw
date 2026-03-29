import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSenderCommandAuthorization } from "./command-auth.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

async function resolveAuthorization(params: {
  senderId: string;
  configuredAllowFrom?: string[];
  configuredGroupAllowFrom?: string[];
}) {
  return resolveSenderCommandAuthorization({
    cfg: baseCfg,
    rawBody: "/status",
    isGroup: true,
    dmPolicy: "pairing",
    configuredAllowFrom: params.configuredAllowFrom ?? ["dm-owner"],
    configuredGroupAllowFrom: params.configuredGroupAllowFrom ?? ["group-owner"],
    senderId: params.senderId,
    isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
    readAllowFromStore: async () => ["paired-user"],
    shouldComputeCommandAuthorized: () => true,
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
  });
}

describe("plugin-sdk/command-auth", () => {
  it.each([
    {
      name: "authorizes group commands from explicit group allowlist",
      senderId: "group-owner",
      expectedAuthorized: true,
      expectedSenderAllowed: true,
    },
    {
      name: "keeps pairing-store identities DM-only for group command auth",
      senderId: "paired-user",
      expectedAuthorized: false,
      expectedSenderAllowed: false,
    },
  ])("$name", async ({ senderId, expectedAuthorized, expectedSenderAllowed }) => {
    const result = await resolveAuthorization({ senderId });
    expect(result.commandAuthorized).toBe(expectedAuthorized);
    expect(result.senderAllowedForCommands).toBe(expectedSenderAllowed);
    expect(result.effectiveAllowFrom).toEqual(["dm-owner"]);
    expect(result.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });
});
