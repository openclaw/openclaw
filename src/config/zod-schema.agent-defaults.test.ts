import { assert, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObject } from "./validation.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

type SchemaParseResult = {
  success: boolean;
  error?: { issues: Array<{ path: Array<string | number | symbol> }> };
};

function expectSchemaFailurePath(result: SchemaParseResult, prefix: string): void {
  assert(!result.success && result.error, `Expected schema validation to fail at ${prefix}.`);
  const paths = result.error.issues.map(({ path }) => path.join("."));
  expect(paths.some((value) => value === prefix || value.startsWith(`${prefix}.`))).toBe(true);
}

const validateAgents = (agents: OpenClawConfig["agents"]) => validateConfigObject({ agents });

describe("agent defaults schema", () => {
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
    const result = validateAgents({
      defaults: { workspace: "/agent-workspace", cwd: "/default-repo" },
      entries: { worker: { cwd: "/agent-repo" } },
    });
    assert(result.ok);
    expect(result.config.agents).toMatchObject({
      defaults: { workspace: "/agent-workspace", cwd: "/default-repo" },
      entries: { worker: { cwd: "/agent-repo" } },
    });
    expect(Object.getOwnPropertyDescriptor(result.config.agents, "list")).toMatchObject({
      enumerable: false,
      value: [{ id: "worker", cwd: "/agent-repo" }],
    });
  });

  it("accepts exact refs, nested wildcards, configured aliases, and compat selectors", () => {
    const result = validateAgents({
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
    });
    expect(result.ok).toBe(true);
  });

  it("reports keyed per-agent policy paths", () => {
    const result = validateAgents({
      ownership: "explicit",
      entries: {
        main: {},
        runner: { modelPolicy: { allow: ["not-a-model-ref"] } },
      },
    });
    assert(!result.ok);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "agents.entries.runner.modelPolicy.allow.0" }),
    );
  });

  it("rejects unsafe byte-size strings in compaction defaults", () => {
    const unsafe = String(Number.MAX_SAFE_INTEGER + 1);
    for (const compaction of [
      { maxActiveTranscriptBytes: unsafe },
      { memoryFlush: { forceFlushTranscriptBytes: unsafe } },
    ]) {
      expect(AgentDefaultsSchema.safeParse({ compaction }).success).toBe(false);
    }
  });

  it("rejects retired heartbeat config at both runtime agent scopes", () => {
    const heartbeat = { every: "30m", target: "owner" };
    expect(AgentDefaultsSchema.safeParse({ heartbeat }).success).toBe(false);
    expect(AgentEntrySchema.safeParse({ id: "ops", heartbeat }).success).toBe(false);
  });
});
