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
  it("resolves command authorization across allowlist sources", async () => {
    const cases = [
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
    ];

    for (const testCase of cases) {
      const result = await resolveAuthorization({ senderId: testCase.senderId });
      expect(result.commandAuthorized).toBe(testCase.expectedAuthorized);
      expect(result.senderAllowedForCommands).toBe(testCase.expectedSenderAllowed);
      expect(result.effectiveAllowFrom).toEqual(["dm-owner"]);
      expect(result.effectiveGroupAllowFrom).toEqual(["group-owner"]);
    }
  });
});
