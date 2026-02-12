import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

describe("normalizeTargetForProvider", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js");
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("preserves slack id case", () => {
    expect(normalizeTargetForProvider("slack", "C0ADKTLND7U")).toBe("channel:C0ADKTLND7U");
  });

  it("preserves case in fallback normalization", () => {
    expect(normalizeTargetForProvider("missing-provider", "  C0ADKTLND7U  ")).toBe("C0ADKTLND7U");
  });
});
