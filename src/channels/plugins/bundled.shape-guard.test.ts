import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../generated/bundled-channel-entries.generated.js");
  vi.resetModules();
});

describe("bundled channel entry shape guards", () => {
  it("treats a missing generated bundled entry export as empty", async () => {
    vi.resetModules();
    vi.doMock("../../generated/bundled-channel-entries.generated.js", () => ({
      GENERATED_BUNDLED_CHANNEL_ENTRIES: undefined,
    }));

    const bundled = await import("./bundled.js");

    expect(bundled.bundledChannelPlugins).toEqual([]);
    expect(bundled.bundledChannelSetupPlugins).toEqual([]);
  });
});
