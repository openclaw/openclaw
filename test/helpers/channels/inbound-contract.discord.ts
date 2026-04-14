import { it } from "vitest";
import { expectChannelInboundContextContract } from "../../../src/channels/plugins/contracts/test-helpers.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type BuildFinalizedDiscordDirectInboundContext =
  () => import("../../../src/auto-reply/templating.js").MsgContext;

const discordInboundContextHarnessModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "discord",
  artifactBasename: "src/monitor/inbound-context.test-helpers.js",
});

async function getBuildFinalizedDiscordDirectInboundContext(): Promise<BuildFinalizedDiscordDirectInboundContext> {
  const module = (await import(discordInboundContextHarnessModuleId)) as {
    buildFinalizedDiscordDirectInboundContext: BuildFinalizedDiscordDirectInboundContext;
  };
  return module.buildFinalizedDiscordDirectInboundContext;
}

export function installDiscordInboundContractSuite() {
  it("keeps inbound context finalized", async () => {
    const buildContext = await getBuildFinalizedDiscordDirectInboundContext();
    const ctx = buildContext();

    expectChannelInboundContextContract(ctx);
  });
}
