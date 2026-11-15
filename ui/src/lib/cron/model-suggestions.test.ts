// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  resolveConfiguredCronModelSuggestions,
  resolveCronModelAgentId,
} from "./model-suggestions.ts";
import { DEFAULT_CRON_FORM } from "./state.ts";

describe("cron model suggestions", () => {
  it("collects configured defaults and the selected agent without borrowing sibling models", () => {
    expect(
      resolveConfiguredCronModelSuggestions(
        {
          agents: {
            defaults: {
              model: { primary: "p/b", fallbacks: ["p/c", "p/d"] },
              models: { "p/a": {}, "p/b": {} },
            },
            entries: {
              writer: { model: { primary: "p/f", fallbacks: ["p/d"] } },
              planner: { model: "p/e" },
            },
          },
        },
        "writer",
      ),
    ).toEqual(["p/a", "p/b", "p/c", "p/d", "p/f"]);
  });

  it("returns no configured model suggestions for invalid or missing config", () => {
    expect(resolveConfiguredCronModelSuggestions(null, undefined)).toStrictEqual([]);
    expect(resolveConfiguredCronModelSuggestions({}, undefined)).toStrictEqual([]);
    expect(
      resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } }, undefined),
    ).toStrictEqual([]);
  });
});

it.each([
  [{ agentId: " WRITER " }, "writer"],
  [{ agentId: "", sessionKey: "agent:planner:main" }, "planner"],
  [{ agentId: "writer", clearAgent: true, sessionKey: "agent:planner:main" }, "planner"],
  [{ agentId: "writer", clearAgent: true, sessionKey: "" }, undefined],
])("resolves model scope from the submitted task fields %j", (patch, expected) => {
  expect(
    resolveCronModelAgentId({ cronForm: { ...DEFAULT_CRON_FORM, ...patch }, cronEditingJob: null }),
  ).toBe(expected);
});
