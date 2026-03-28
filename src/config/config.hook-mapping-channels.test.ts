import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

describe("hook mapping channel validation", () => {
  it("accepts configured runtime channel ids such as feishu", () => {
    const res = validateConfigObjectWithPlugins({
      channels: {
        feishu: {
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
        },
      },
      hooks: {
        mappings: [
          {
            deliver: true,
            channel: "feishu",
            to: "test",
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown hook mapping channel ids", () => {
    const res = validateConfigObjectWithPlugins({
      hooks: {
        mappings: [
          {
            deliver: true,
            channel: "definitely-not-a-channel",
            to: "test",
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toContainEqual(
      expect.objectContaining({
        path: "hooks.mappings.0.channel",
        message: expect.stringContaining("unknown hook mapping channel"),
      }),
    );
  });
});
