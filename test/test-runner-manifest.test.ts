import { describe, expect, it } from "vitest";
import { loadTestRunnerBehavior } from "../scripts/test-runner-manifest.mjs";

describe("loadTestRunnerBehavior", () => {
  it("loads channel isolated entries from the behavior manifest", () => {
    const behavior = loadTestRunnerBehavior();
    const files = behavior.channels.isolated.map((entry) => entry.file);

    expect(files).toContain(
      "extensions/discord/src/monitor/message-handler.preflight.acp-bindings.test.ts",
    );
  });

  it("loads channel isolated prefixes from the behavior manifest", () => {
    const behavior = loadTestRunnerBehavior();

    expect(behavior.channels.isolatedPrefixes).toContain("extensions/discord/src/monitor/");
  });
});
