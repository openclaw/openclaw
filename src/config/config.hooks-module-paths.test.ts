// Covers hook module path config validation.
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

function mappingConfig(mapping: Record<string, unknown>) {
  return {
    agents: { entries: { openclaw: {} } },
    hooks: { mappings: [{ match: { path: "custom" }, action: "agent", ...mapping }] },
  };
}

describe("config hooks module paths", () => {
  const expectRejectedIssuePath = (config: Record<string, unknown>, expectedPath: string) => {
    const res = validateConfigObjectWithPlugins(config);
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected validation failure");
    }
    expect(res.issues.map((issue) => issue.path)).toContain(expectedPath);
  };

  it.each(["/tmp/transform.mjs", "../escape.mjs"])(
    "rejects unsafe transform module %s",
    (module) => {
      expectRejectedIssuePath(
        mappingConfig({ transform: { module } }),
        "hooks.mappings.0.transform.module",
      );
    },
  );

  it("rejects retired hooks.internal.handlers registrations", () => {
    expectRejectedIssuePath(
      {
        agents: { entries: { openclaw: {} } },
        hooks: {
          internal: {
            enabled: true,
            handlers: [{ event: "command:new", module: "hooks/handler.mjs" }],
          },
        },
      },
      "hooks.internal",
    );
  });

  it("accepts hooks.mappings[].channel runtime plugin ids", () => {
    const res = validateConfigObjectWithPlugins(
      mappingConfig({ channel: "collabchat", messageTemplate: "hello" }),
    );
    expect(res.ok).toBe(true);
  });

  it("rejects blank hooks.mappings[].channel values", () => {
    expectRejectedIssuePath(mappingConfig({ channel: "   " }), "hooks.mappings.0.channel");
  });
});
