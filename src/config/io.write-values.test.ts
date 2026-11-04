import { describe, expect, it } from "vitest";
import { prepareConfigWriteValues } from "./io.write-prepare.js";
import { createSnapshot } from "./mutate.test-support.js";

describe("config write input environment basis", () => {
  it.each([
    { name: "unchanged read-time value", input: "old-value", authored: "${FIXTURE_TOKEN}" },
    { name: "literal edited to the later env value", input: "new-value", authored: "new-value" },
  ])("preserves $name across a later snapshot", ({ input, authored }) => {
    const original = { messages: { responsePrefix: "${FIXTURE_TOKEN}" } };
    const current = { messages: { responsePrefix: "new-value" } };
    const snapshot = {
      ...createSnapshot({
        path: "/fixture/config.json",
        sourceConfig: current,
        raw: JSON.stringify(original),
        parsed: original,
      }),
      authoredConfig: original,
    };
    const nextConfig = { messages: { responsePrefix: input } };
    const values = prepareConfigWriteValues({
      snapshot,
      nextConfig,
      env: { FIXTURE_TOKEN: "new-value" },
      writeOptions: {
        expectedConfigPath: snapshot.path,
        envSnapshotForRestore: { FIXTURE_TOKEN: "old-value" },
      },
      explicitSetPaths: [["messages", "responsePrefix"]],
      explicitSetValueSource: nextConfig,
    });
    expect(values.authoredConfig.messages?.responsePrefix).toBe(authored);
    expect(values.explicitSetValueSource.messages?.responsePrefix).toBe(authored);
    expect(values.resolvedConfig.messages?.responsePrefix).toBe("new-value");
    expect(values.authoredSourceConfig.messages?.responsePrefix).toBe("${FIXTURE_TOKEN}");
    expect(values.authoredRuntimeConfig.messages?.responsePrefix).toBe("${FIXTURE_TOKEN}");
  });
});
