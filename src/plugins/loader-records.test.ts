import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";

describe("plugin loader records", () => {
  it("preserves manifest-declared channel ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      channelIds: ["kitchen-sink-channel"],
      configSchema: false,
    });

    expect(record.channelIds).toEqual(["kitchen-sink-channel"]);
  });
});
