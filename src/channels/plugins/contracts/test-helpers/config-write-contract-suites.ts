import { expect, it } from "vitest";
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
  const channel = { configWrites: true, accounts: { [accountIdKey]: { configWrites: false } } };
  return { channels: { [origin.channelId]: channel, [target.channelId]: channel } };
}

export function describeChannelConfigWritePolicyContract() {
  it.each(["target", "origin"] as const)("blocks when the %s account disables writes", (kind) => {
    const scope = kind === "target" ? target : origin;
    const result = authorizeConfigWrite({
      cfg: makeDemoConfigWritesCfg(scope.accountId),
      origin,
      target: resolveExplicitConfigWriteTarget({ ...scope, accountId: "work" }),
    });
    expect(result).toEqual({
      allowed: false,
      reason: `${kind}-disabled`,
      blockedScope: { kind, scope },
    });
  });

  it.each([true, false])("allows writes (internal admin bypass: %s)", (internal) => {
    const result = authorizeConfigWrite({
      cfg: makeDemoConfigWritesCfg("work"),
      origin,
      target: internal
        ? resolveExplicitConfigWriteTarget(target)
        : resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
      allowBypass: canBypassConfigWritePolicy({
        channel: internal ? INTERNAL_MESSAGE_CHANNEL : undefined,
        gatewayClientScopes: ["operator.admin"],
      }),
    });
    expect(result).toEqual({ allowed: true });
  });
}

export function describeChannelConfigWriteTargetContract() {
  it.each([
    ["channels", "demo-channel"],
    ["channels", "demo-channel", "accounts"],
  ])("rejects collection writes at %s.%s.%s", (...pathSegments) => {
    expect(resolveConfigWriteTargetFromPath(pathSegments)).toEqual({
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
}
