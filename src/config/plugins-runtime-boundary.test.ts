import { describe, expect, it } from "vitest";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { OpenClawSchema } from "./zod-schema.js";

function hasLegacyPluginsRuntimeKeys(keys: string[]): boolean {
  return keys.some((key) => key === "plugins.runtime" || key.startsWith("plugins.runtime."));
}

describe("plugins runtime boundary config", () => {
  it("omits legacy plugins.runtime keys from schema metadata", () => {
    expect(hasLegacyPluginsRuntimeKeys(Object.keys(FIELD_HELP))).toBe(false);
    expect(hasLegacyPluginsRuntimeKeys(Object.keys(FIELD_LABELS))).toBe(false);
  });

  it("omits plugins.runtime from the generated config schema", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-7",
      io: "input",
      reused: "ref",
    }) as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const pluginsProperties = schema.properties?.plugins?.properties ?? {};
    expect("runtime" in pluginsProperties).toBe(false);
  });

  it("accepts plugin entry with apiKey and env fields", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "my-plugin": {
            enabled: true,
            apiKey: "sk-test-123",
            env: { MY_VAR: "value" },
            config: { mode: "auto" },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("tolerates unknown keys in plugin entry without crashing (#43551)", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "openclaw-mem0": {
            enabled: true,
            mode: "auto",
            userId: "user-123",
            autoCapture: true,
            autoRecall: false,
            oss: true,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects legacy plugins.runtime config entries", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        runtime: {
          allowLegacyExec: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
