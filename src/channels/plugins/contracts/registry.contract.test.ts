import { describe, expect, it } from "vitest";
import { discordSessionBindingAdapterChannels } from "../../../../extensions/discord/runtime-api.js";
import { feishuSessionBindingAdapterChannels } from "../../../../extensions/feishu/api.js";
import { matrixSessionBindingAdapterChannels } from "../../../../extensions/matrix/api.js";
import { telegramSessionBindingAdapterChannels } from "../../../../extensions/telegram/runtime-api.js";
import { sessionBindingContractChannelIds } from "./manifest.js";

function discoverSessionBindingChannels() {
  return [
    ...new Set([
      ...discordSessionBindingAdapterChannels,
      ...feishuSessionBindingAdapterChannels,
      ...matrixSessionBindingAdapterChannels,
      ...telegramSessionBindingAdapterChannels,
    ]),
  ].toSorted();
}

describe("channel contract registry", () => {
  it("keeps session binding coverage aligned with registered session binding adapters", () => {
    expect([...sessionBindingContractChannelIds]).toEqual(discoverSessionBindingChannels());
  });
});
