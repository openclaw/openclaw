import { describe, expect, it } from "vitest";
import { sessionBindingContractChannelIds } from "../../../src/channels/plugins/contracts/manifest.js";

export function describeSessionBindingContractCoverage(channelIds: readonly string[]) {
  describe("session binding contract coverage", () => {
    for (const channelId of channelIds) {
      it(`includes ${channelId} in the shared session binding contract registry`, () => {
        expect(sessionBindingContractChannelIds).toContain(channelId);
      });
    }
  });
}
