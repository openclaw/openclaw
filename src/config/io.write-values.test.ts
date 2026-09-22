import { describe, expect, it } from "vitest";
import { prepareConfigWriteValues } from "./io.write-prepare.js";
import type { ConfigFileSnapshot } from "./types.js";

describe("config write input environment basis", () => {
  it.each([
    { name: "unchanged read-time value", input: "old-value", authored: "${FIXTURE_TOKEN}" },
    { name: "literal edited to the later env value", input: "new-value", authored: "new-value" },
  ])("preserves $name across a later snapshot", ({ input, authored }) => {
    const original = { messages: { responsePrefix: "${FIXTURE_TOKEN}" } };
    const current = { messages: { responsePrefix: "new-value" } };
    const snapshot: ConfigFileSnapshot = {
      path: "/fixture/config.json",
      exists: true,
      raw: JSON.stringify(original),
      parsed: original,
      authoredConfig: original,
      sourceConfig: current,
      resolved: current,
      runtimeConfig: current,
      config: current,
      valid: true,
      issues: [],
      warnings: [],
      legacyIssues: [],
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
