import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../../utils/message-channel.js";
import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveExplicitConfigWriteTarget,
  resolveConfigWriteTargetFromPath,
} from "../../config-writes.js";

const origin = { channelId: "demo-origin", accountId: "default" };
const target = { channelId: "demo-target", accountId: "work" };

function makeDemoConfigWritesCfg(accountIdKey: string) {
  const channel = () => ({
    configWrites: true,
    accounts: { [accountIdKey]: { configWrites: false } },
  });
  return {
    channels: {
      [origin.channelId]: channel(),
      [target.channelId]: channel(),
    },
  };
}

export function describeChannelConfigWritePolicyContract() {
  describe("authorizeConfigWrite policy contract", () => {
    it.each(["target", "origin"] as const)("blocks when the %s account disables writes", (kind) => {
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
    });

    it.each([
      [
        "allows bypass for internal operator.admin writes",
        {
          target: resolveExplicitConfigWriteTarget(target),
          allowBypass: canBypassConfigWritePolicy({
            channel: INTERNAL_MESSAGE_CHANNEL,
            gatewayClientScopes: ["operator.admin"],
          }),
        },
      ],
      [
        "treats non-channel config paths as global writes",
        {
          target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
        },
      ],
    ] as const)("%s", (_name, input) => {
      expect(
        authorizeConfigWrite({ cfg: makeDemoConfigWritesCfg("work"), origin, ...input }),
      ).toEqual({ allowed: true });
    });
  });
}

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
      ["channel", { channelId: origin.channelId }],
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
      ).toContain(`channels.${target.channelId}.accounts.work.configWrites=true`);
    });
  });
}
