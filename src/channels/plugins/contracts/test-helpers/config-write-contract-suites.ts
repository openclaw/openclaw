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
const origin = { channelId: demoOriginChannelId, accountId: "default" };
const target = { channelId: demoTargetChannelId, accountId: "work" };

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

function expectConfigWriteBlocked(kind: "target" | "origin") {
  const scope = kind === "target" ? target : origin;
  expect(
    authorizeConfigWrite({
      cfg: makeDemoConfigWritesCfg(scope.accountId),
      origin,
      target: resolveExplicitConfigWriteTarget({ ...scope, accountId: "work" }),
    }),
  ).toEqual({
    allowed: false,
    reason: `${kind}-disabled`,
    blockedScope: { kind, scope },
  });
}

/** Installs policy tests for allowed, denied, and bypassed config writes. */
export function describeChannelConfigWritePolicyContract() {
  describe("authorizeConfigWrite policy contract", () => {
    it.each(["target", "origin"] as const)(
      "blocks when the %s account disables writes",
      expectConfigWriteBlocked,
    );

    it.each([
      {
        name: "allows bypass for internal operator.admin writes",
        input: {
          target: resolveExplicitConfigWriteTarget(target),
          allowBypass: canBypassConfigWritePolicy({
            channel: INTERNAL_MESSAGE_CHANNEL,
            gatewayClientScopes: ["operator.admin"],
          }),
        },
      },
      {
        name: "treats non-channel config paths as global writes",
        input: {
          target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
        },
      },
    ] as const)("$name", ({ input }) => {
      expect(
        authorizeConfigWrite({ cfg: makeDemoConfigWritesCfg("work"), origin, ...input }),
      ).toEqual({ allowed: true });
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
      ["channel", { channelId: demoOriginChannelId }],
      ["account", target],
    ] as const)("resolves explicit %s target", (kind, scope) => {
      expect(resolveExplicitConfigWriteTarget(scope)).toEqual({ kind, scope });
    });

    it("formats denied messages consistently", () => {
      expect(
        formatConfigWriteDeniedMessage({
          result: {
            allowed: false,
            reason: "target-disabled",
            blockedScope: { kind: "target", scope: target },
          },
        }),
      ).toContain(`channels.${demoTargetChannelId}.accounts.work.configWrites=true`);
    });
  });
}
