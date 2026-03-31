import { expect, it } from "vitest";
import { isAllowedBlueBubblesSender } from "../../../src/plugin-sdk/bluebubbles-policy.js";
import { isMattermostSenderAllowed } from "../../../src/plugin-sdk/mattermost-policy.js";
import {
  isSignalSenderAllowed,
  type SignalSender,
} from "../../../src/plugin-sdk/signal-surface.js";
import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists,
} from "../../../src/security/dm-policy-shared.js";

type ChannelSmokeCase = {
  storeAllowFrom: string[];
  isSenderAllowed: (allowFrom: string[]) => boolean;
};

const signalSender: SignalSender = {
  kind: "phone",
  raw: "+15550001111",
  e164: "+15550001111",
};

const dmPolicyCases = {
  bluebubbles: {
    storeAllowFrom: ["attacker-user"],
    isSenderAllowed: (allowFrom: string[]) =>
      isAllowedBlueBubblesSender({
        allowFrom,
        sender: "attacker-user",
        chatId: 101,
      }),
  },
  signal: {
    storeAllowFrom: [signalSender.e164],
    isSenderAllowed: (allowFrom: string[]) => isSignalSenderAllowed(signalSender, allowFrom),
  },
  mattermost: {
    storeAllowFrom: ["user:attacker-user"],
    isSenderAllowed: (allowFrom: string[]) =>
      isMattermostSenderAllowed({
        senderId: "attacker-user",
        senderName: "Attacker",
        allowFrom,
      }),
  },
} satisfies Record<string, ChannelSmokeCase>;

export function installDmPolicyContractSuite(channel: keyof typeof dmPolicyCases) {
  const testCase = dmPolicyCases[channel];

  for (const ingress of ["message", "reaction"] as const) {
    it(`blocks group ${ingress} when sender is only in pairing store`, () => {
      const access = resolveDmGroupAccessWithLists({
        isGroup: true,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        allowFrom: ["owner-user"],
        groupAllowFrom: ["group-owner"],
        storeAllowFrom: testCase.storeAllowFrom,
        isSenderAllowed: testCase.isSenderAllowed,
      });
      expect(access.decision).toBe("block");
      expect(access.reasonCode).toBe(DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED);
      expect(access.reason).toBe("groupPolicy=allowlist (not allowlisted)");
    });
  }
}
