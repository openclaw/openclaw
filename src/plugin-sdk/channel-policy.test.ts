import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import type { GroupPolicy } from "../config/types.base.js";
import { createRestrictSendersChannelSecurity } from "./channel-policy.js";

describe("createRestrictSendersChannelSecurity", () => {
  it("builds dm policy resolution and open-group warnings from one descriptor", async () => {
    const security = createRestrictSendersChannelSecurity<{
      accountId: string;
      allowFrom?: string[];
      dmPolicy?: string;
      groupPolicy?: GroupPolicy;
    }>({
      channelKey: "line",
      resolveDmPolicy: (account) => account.dmPolicy,
      resolveDmAllowFrom: (account) => account.allowFrom,
      resolveGroupPolicy: (account) => account.groupPolicy,
      surface: "LINE groups",
      openScope: "any member in groups",
      groupPolicyPath: "channels.line.groupPolicy",
      groupAllowFromPath: "channels.line.groupAllowFrom",
      mentionGated: false,
      policyPathSuffix: "dmPolicy",
    });

    expect(
      security.resolveDmPolicy?.({
        cfg: { channels: {} } as never,
        accountId: "default",
        account: {
          accountId: "default",
          dmPolicy: "allowlist",
          allowFrom: ["line:user:abc"],
        },
      }),
    ).toEqual({
      policy: "allowlist",
      allowFrom: ["line:user:abc"],
      policyPath: "channels.line.dmPolicy",
      allowFromPath: "channels.line.",
      approveHint: formatPairingApproveHint("line"),
      normalizeEntry: undefined,
    });

    expect(
      security.collectWarnings?.({
        cfg: { channels: { line: {} } } as never,
        accountId: "default",
        account: {
          accountId: "default",
          groupPolicy: "open",
        },
      }),
    ).toEqual([
      '- LINE groups: groupPolicy="open" allows any member in groups to trigger. Set channels.line.groupPolicy="allowlist" + channels.line.groupAllowFrom to restrict senders.',
    ]);
  });
});
