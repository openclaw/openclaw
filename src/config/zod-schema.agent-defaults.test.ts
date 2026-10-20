import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

type SchemaParseResult = {
  success: boolean;
  error?: { issues: Array<{ path: Array<string | number | symbol> }> };
};

function expectSchemaFailurePath(result: SchemaParseResult, prefix: string): void {
  expect(result.success).toBe(false);
  if (result.success || !result.error) {
    throw new Error(`Expected schema validation to fail at ${prefix}.`);
  }
  expect(
    result.error.issues.some(({ path }) => {
      const value = path.join(".");
      return value === prefix || value.startsWith(`${prefix}.`);
    }),
  ).toBe(true);
}

describe("agent defaults schema", () => {
  it("keeps cache-expiry compaction opt-in and rejects invented timer settings", () => {
    expect(AgentDefaultsSchema.parse({ compaction: {} })).toEqual({ compaction: {} });
    expect(AgentDefaultsSchema.parse({ compaction: { cacheExpiry: { enabled: true } } })).toEqual({
      compaction: { cacheExpiry: { enabled: true } },
    });
    expect(
      AgentDefaultsSchema.safeParse({ compaction: { cacheExpiry: { enabled: "yes" } } }).success,
    ).toBe(false);
    expect(
      AgentDefaultsSchema.safeParse({ compaction: { cacheExpiry: { ttl: "55m" } } }).success,
    ).toBe(false);
  });
  it("accepts bounded explicit picker runtimes only on exact model refs", () => {
    const models = {
      "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" }, pickerRuntimes: ["codex"] },
    };
    expect(AgentDefaultsSchema.parse({ models })?.models).toEqual(models);
    expect(AgentEntrySchema.parse({ id: "ops", models }).models).toEqual(models);
    for (const pickerRuntimes of [["auto"], [""], ["unknown runtime"], Array(9).fill("codex")]) {
      expectSchemaFailurePath(
        AgentDefaultsSchema.safeParse({ models: { "openai/gpt-5.6-sol": { pickerRuntimes } } }),
        "models.openai/gpt-5.6-sol.pickerRuntimes",
      );
    }
    for (const key of ["openai/*", "model"]) {
      expectSchemaFailurePath(
        AgentEntrySchema.safeParse({ id: "ops", models: { [key]: { pickerRuntimes: ["codex"] } } }),
        `models.${key}.pickerRuntimes`,
      );
    }
  });

  it("preserves separate run directories through config validation and list projection", () => {
    const result = validateConfigObject({
      agents: {
        defaults: { workspace: "/agent-workspace", cwd: "/default-repo" },
        entries: { worker: { cwd: "/agent-repo" } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.config.agents?.defaults).toMatchObject({
      workspace: "/agent-workspace",
      cwd: "/default-repo",
    });
    expect(result.config.agents?.entries?.worker?.cwd).toBe("/agent-repo");
    expect(Object.getOwnPropertyDescriptor(result.config.agents, "list")).toMatchObject({
      enumerable: false,
      value: [{ id: "worker", cwd: "/agent-repo" }],
    });
  });

  it("accepts exact refs, nested wildcards, configured aliases, and compat selectors", () => {
    const result = validateConfigObject({
      agents: {
        entries: { main: {} },
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            "openrouter/openai/gpt-oss-120b:free": {},
          },
          modelPolicy: {
            allow: [
              "openai/gpt-5.6-sol",
              "provider/a/b/c/d/e/f",
              "clawrouter/anthropic/*",
              "provider/a/b/c/d/*",
              "sonnet",
              "openrouter:free",
            ],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("reports keyed per-agent policy paths", () => {
    const result = validateConfigObject({
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          runner: { modelPolicy: { allow: ["not-a-model-ref"] } },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "agents.entries.runner.modelPolicy.allow.0" }),
      );
    }
  });

  it("rejects unsafe byte-size strings in compaction defaults", () => {
    const unsafe = String(Number.MAX_SAFE_INTEGER + 1);
    expect(
      AgentDefaultsSchema.safeParse({ compaction: { maxActiveTranscriptBytes: unsafe } }).success,
    ).toBe(false);
    expect(
      AgentDefaultsSchema.safeParse({
        compaction: { memoryFlush: { forceFlushTranscriptBytes: unsafe } },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid heartbeat activeHours without an explicit cadence", () => {
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({
        heartbeat: { activeHours: { start: "99:99", end: "17:00" } },
      }),
      "heartbeat.activeHours.start",
    );
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({
        id: "ops",
        heartbeat: { activeHours: { start: "09:00", end: "not-a-time" } },
      }),
      "heartbeat.activeHours.end",
    );
  });
});
