import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSenderCommandAuthorization } from "./command-auth.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

describe("plugin-sdk/command-auth", () => {
  it("authorizes group commands from explicit group allowlist", async () => {
    const result = await resolveSenderCommandAuthorization({
      cfg: baseCfg,
      rawBody: "/status",
      isGroup: true,
      dmPolicy: "pairing",
      configuredAllowFrom: ["dm-owner"],
      configuredGroupAllowFrom: ["group-owner"],
      senderId: "group-owner",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readAllowFromStore: async () => ["paired-user"],
      shouldComputeCommandAuthorized: () => true,
      resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
        useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
    });
    expect(result.commandAuthorized).toBe(true);
    expect(result.senderAllowedForCommands).toBe(true);
    expect(result.effectiveAllowFrom).toEqual(["dm-owner"]);
    expect(result.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });

  it("keeps pairing-store identities DM-only for group command auth", async () => {
    const result = await resolveSenderCommandAuthorization({
      cfg: baseCfg,
      rawBody: "/status",
      isGroup: true,
      dmPolicy: "pairing",
      configuredAllowFrom: ["dm-owner"],
      configuredGroupAllowFrom: ["group-owner"],
      senderId: "paired-user",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readAllowFromStore: async () => ["paired-user"],
      shouldComputeCommandAuthorized: () => true,
      resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
        useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
    });
    expect(result.commandAuthorized).toBe(false);
    expect(result.senderAllowedForCommands).toBe(false);
    expect(result.effectiveAllowFrom).toEqual(["dm-owner"]);
    expect(result.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });
});
