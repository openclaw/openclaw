import { describe, expect, it } from "vitest";
import { feishuSessionBindingAdapterChannels } from "../../../../extensions/feishu/api.js";
import { matrixSessionBindingAdapterChannels } from "../../../../extensions/matrix/api.js";
import { sessionBindingContractChannelIds } from "./manifest.js";

function discoverSessionBindingChannels() {
  return [
    ...new Set([
      ...discordSessionBindingAdapterChannels,
      ...feishuSessionBindingAdapterChannels,
      ...matrixSessionBindingAdapterChannels,
      "telegram",
    ]),
  ].toSorted();
}

const discordSessionBindingAdapterChannels = ["discord"] as const;

describe("channel contract registry", () => {
  it("keeps session binding coverage aligned with registered session binding adapters", () => {
    expect([...sessionBindingContractChannelIds]).toEqual(discoverSessionBindingChannels());
  });
});
