import { describe, expect, it } from "vitest";
import {
  loadChannelTimingManifest,
  loadTestRunnerBehavior,
} from "../scripts/test-runner-manifest.mjs";
import { bundledPluginDirPrefix, bundledPluginFile } from "./helpers/bundled-plugin-paths.js";

describe("loadTestRunnerBehavior", () => {
  it("loads channel isolated entries from the behavior manifest", () => {
    const behavior = loadTestRunnerBehavior();
    const files = behavior.channels.isolated.map((entry) => entry.file);

    expect(files).toContain(
      bundledPluginFile("discord", "src/monitor/message-handler.preflight.acp-bindings.test.ts"),
    );
  });

  it("loads channel isolated prefixes from the behavior manifest", () => {
    const behavior = loadTestRunnerBehavior();

    expect(behavior.channels.isolatedPrefixes).toContain(
      bundledPluginDirPrefix("discord", "src/monitor"),
    );
  });

  it("loads channel timing metadata from the timing manifest", () => {
    const timings = loadChannelTimingManifest();

    expect(timings.config).toBe("vitest.channels.config.ts");
    expect(Object.keys(timings.files).length).toBeGreaterThan(0);
  });
});
