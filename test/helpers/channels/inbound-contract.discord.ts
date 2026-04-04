import { it } from "vitest";
import { expectChannelInboundContextContract } from "../../../src/channels/plugins/contracts/test-helpers.js";
import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type BuildFinalizedDiscordDirectInboundContext =
  () => import("../../../src/auto-reply/templating.js").MsgContext;

let buildFinalizedDiscordDirectInboundContextCache:
  | BuildFinalizedDiscordDirectInboundContext
  | undefined;

function getBuildFinalizedDiscordDirectInboundContext(): BuildFinalizedDiscordDirectInboundContext {
  if (!buildFinalizedDiscordDirectInboundContextCache) {
    ({ buildFinalizedDiscordDirectInboundContext: buildFinalizedDiscordDirectInboundContextCache } =
      loadBundledPluginTestApiSync<{
        buildFinalizedDiscordDirectInboundContext: BuildFinalizedDiscordDirectInboundContext;
      }>("discord"));
  }
  return buildFinalizedDiscordDirectInboundContextCache;
}

export function installDiscordInboundContractSuite() {
  it("keeps inbound context finalized", () => {
    const ctx = getBuildFinalizedDiscordDirectInboundContext()();

    expectChannelInboundContextContract(ctx);
  });
}
