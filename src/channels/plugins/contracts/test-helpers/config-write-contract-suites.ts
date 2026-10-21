import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../../utils/message-channel.js";
import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveExplicitConfigWriteTarget,
  resolveConfigWriteTargetFromPath,
} from "../../config-writes.js";

const demoOriginChannelId = "demo-origin";
const demoTargetChannelId = "demo-target";

function makeDemoConfigWritesCfg(accountIdKey: string) {
  const channel = () => ({
    configWrites: true,
    accounts: { [accountIdKey]: { configWrites: false } },
  });
  return {
    channels: {
      [demoOriginChannelId]: channel(),
      [demoTargetChannelId]: channel(),
    },
  };
}

function expectConfigWriteBlocked(params: {
  disabledAccountId: string;
  reason: "target-disabled" | "origin-disabled";
  blockedScope: "target" | "origin";
}) {
  expect(
    authorizeConfigWrite({
      cfg: makeDemoConfigWritesCfg(params.disabledAccountId),
      origin: { channelId: demoOriginChannelId, accountId: "default" },
      target: resolveExplicitConfigWriteTarget({
        channelId: params.blockedScope === "target" ? demoTargetChannelId : demoOriginChannelId,
        accountId: "work",
      }),
    }),
  ).toEqual({
    allowed: false,
    reason: params.reason,
    blockedScope: {
      kind: params.blockedScope,
      scope: {
        channelId: params.blockedScope === "target" ? demoTargetChannelId : demoOriginChannelId,
        accountId: params.blockedScope === "target" ? "work" : "default",
      },
    },
  });
}

/** Installs policy tests for allowed, denied, and bypassed config writes. */
export function describeChannelConfigWritePolicyContract() {
  describe("authorizeConfigWrite policy contract", () => {
    it.each([
      {
        name: "blocks when a target account disables writes",
        disabledAccountId: "work",
        reason: "target-disabled",
        blockedScope: "target",
      },
      {
        name: "blocks when the origin account disables writes",
        disabledAccountId: "default",
        reason: "origin-disabled",
        blockedScope: "origin",
      },
    ] as const)("$name", (testCase) => {
      expectConfigWriteBlocked(testCase);
    });

    it.each([
      {
        name: "allows bypass for internal operator.admin writes",
        input: {
          cfg: makeDemoConfigWritesCfg("work"),
          origin: { channelId: demoOriginChannelId, accountId: "default" },
          target: resolveExplicitConfigWriteTarget({
            channelId: demoTargetChannelId,
            accountId: "work",
          }),
          allowBypass: canBypassConfigWritePolicy({
            channel: INTERNAL_MESSAGE_CHANNEL,
            gatewayClientScopes: ["operator.admin"],
          }),
        },
        expected: { allowed: true },
      },
      {
        name: "treats non-channel config paths as global writes",
        input: {
          cfg: makeDemoConfigWritesCfg("work"),
          origin: { channelId: demoOriginChannelId, accountId: "default" },
          target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
        },
        expected: { allowed: true },
      },
    ] as const)("$name", ({ input, expected }) => {
      expect(authorizeConfigWrite(input)).toEqual(expected);
    });
  });
}

/** Installs target-resolution tests for path-derived and explicit writes. */
export function describeChannelConfigWriteTargetContract() {
  describe("authorizeConfigWrite target contract", () => {
    it.each([
      ["rejects bare channel collection writes", ["channels", "demo-channel"]],
      ["rejects account collection writes", ["channels", "demo-channel", "accounts"]],
    ] as const)("%s", (_name, pathSegments) => {
      expect(resolveConfigWriteTargetFromPath([...pathSegments])).toEqual({
        kind: "ambiguous",
        scopes: [{ channelId: "demo-channel" }],
      });
    });

    it.each([
      {
        name: "resolves explicit channel target",
        input: { channelId: demoOriginChannelId },
        expected: { kind: "channel", scope: { channelId: demoOriginChannelId } },
      },
      {
        name: "resolves explicit account target",
        input: { channelId: demoTargetChannelId, accountId: "work" },
        expected: { kind: "account", scope: { channelId: demoTargetChannelId, accountId: "work" } },
      },
    ] as const)("$name", ({ input, expected }) => {
      expect(resolveExplicitConfigWriteTarget(input)).toEqual(expected);
    });

    it("formats denied messages consistently", () => {
      expect(
        formatConfigWriteDeniedMessage({
          result: {
            allowed: false,
            reason: "target-disabled",
            blockedScope: {
              kind: "target",
              scope: { channelId: demoTargetChannelId, accountId: "work" },
            },
          },
        }),
      ).toContain(`channels.${demoTargetChannelId}.accounts.work.configWrites=true`);
    });
  });
}
