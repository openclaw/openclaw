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
    expect(result.config.agents?.list?.[0]?.cwd).toBe("/agent-repo");
  });

  it("requires exact model refs even when disabling Code Mode", () => {
    for (const key of ["openai/*", "model"]) {
      const models = { [key]: { codeMode: false } };
      expectSchemaFailurePath(AgentDefaultsSchema.safeParse({ models }), `models.${key}.codeMode`);
      expectSchemaFailurePath(
        AgentEntrySchema.safeParse({ id: "ops", models }),
        `models.${key}.codeMode`,
      );
    }
    const models = { "openai/*": { agentRuntime: { id: "openclaw" } } };
    expect(AgentDefaultsSchema.parse({ models })?.models).toEqual(models);
    expect(AgentEntrySchema.parse({ id: "ops", models }).models).toEqual(models);
  });

  it("preserves disabled per-model Code Mode overrides", () => {
    const models = {
      "example/model": {
        alias: "test",
        params: { temperature: 0.5 },
        agentRuntime: { id: "openclaw" },
        streaming: false,
        codeMode: false,
      },
    };
    expect(AgentDefaultsSchema.parse({ models })?.models).toEqual(models);
    expect(AgentEntrySchema.parse({ id: "ops", models }).models).toEqual(models);
  });

  it("rejects malformed model policy refs during config validation", () => {
    for (const entry of ["", "///", "provider//model", "nogarbageprovider"]) {
      const result = validateConfigObject({
        agents: {
          defaults: { modelPolicy: { allow: [entry] } },
          entries: { main: {} },
        },
      });
      expect(result.ok, entry || "empty entry").toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ path: "agents.defaults.modelPolicy.allow.0" }),
        );
      }
    }
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

  it("accepts mediaModels.image timeoutMs", () => {
    const image = { primary: "openrouter/openai/gpt-5.4-image-2", timeoutMs: 180_000 };
    expect(AgentDefaultsSchema.parse({ mediaModels: { image } })?.mediaModels?.image).toEqual(
      image,
    );
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({ mediaModels: { image: { ...image, timeoutMs: 0 } } }),
      "mediaModels.image.timeoutMs",
    );
  });

  it("keeps subagent model config to model selection only", () => {
    const model = { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] };
    expect(AgentDefaultsSchema.parse({ subagents: { model } })?.subagents?.model).toEqual(model);
    expect(AgentEntrySchema.parse({ id: "worker", subagents: { model } }).subagents?.model).toEqual(
      model,
    );
    const subagents = { model: { primary: "openai/gpt-5.5", timeoutMs: 30_000 } };
    expectSchemaFailurePath(AgentDefaultsSchema.safeParse({ subagents }), "subagents.model");
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({ id: "worker", subagents }),
      "subagents.model",
    );
  });

  it("accepts experimental agent flags", () => {
    expect(
      AgentDefaultsSchema.parse({ experimental: { localModelLean: true } })?.experimental
        ?.localModelLean,
    ).toBe(true);
  });

  it("accepts contextInjection: never", () => {
    expect(AgentDefaultsSchema.parse({ contextInjection: "never" })?.contextInjection).toBe(
      "never",
    );
  });

  it("accepts explicit inherited compaction thinking", () => {
    expect(
      AgentDefaultsSchema.parse({ compaction: { thinkingLevel: "inherit" } })?.compaction
        ?.thinkingLevel,
    ).toBe("inherit");
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

  it("accepts compaction.enabled so auto-compaction can be turned off", () => {
    expect(AgentDefaultsSchema.parse({ compaction: { enabled: false } })?.compaction?.enabled).toBe(
      false,
    );
  });

  it("accepts focused contextLimits on defaults and agent entries", () => {
    const defaults = AgentDefaultsSchema.parse({
      contextLimits: { memoryGetMaxChars: 20_000, postCompactionMaxChars: 4_000 },
    });
    const agent = AgentEntrySchema.parse({
      id: "ops",
      skillsLimits: { maxSkillsPromptChars: 30_000 },
      contextLimits: { memoryGetMaxChars: 18_000 },
    });
    expect(defaults?.contextLimits?.memoryGetMaxChars).toBe(20_000);
    expect(agent.skillsLimits?.maxSkillsPromptChars).toBe(30_000);
    expect(agent.contextLimits?.memoryGetMaxChars).toBe(18_000);
  });

  it("accepts positive heartbeat timeoutSeconds on defaults and agent entries", () => {
    expect(
      AgentDefaultsSchema.parse({ heartbeat: { timeoutSeconds: 45 } })?.heartbeat?.timeoutSeconds,
    ).toBe(45);
    expect(
      AgentEntrySchema.parse({ id: "ops", heartbeat: { timeoutSeconds: 45 } }).heartbeat
        ?.timeoutSeconds,
    ).toBe(45);
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

  it("accepts per-agent TTS overrides", () => {
    const agent = AgentEntrySchema.parse({
      id: "reader",
      tts: {
        provider: "openai",
        auto: "always",
        providers: { openai: { voice: "nova", apiKey: "${OPENAI_API_KEY}" } },
      },
    });
    expect(agent.tts?.provider).toBe("openai");
    expect(agent.tts?.providers?.openai?.voice).toBe("nova");
  });

  it("accepts per-agent tools.codeMode config", () => {
    expect(
      AgentEntrySchema.safeParse({ id: "ops", tools: { codeMode: { enabled: true } } }).success,
    ).toBe(true);
    expect(AgentEntrySchema.safeParse({ id: "ops", tools: { codeMode: true } }).success).toBe(true);
    expect(
      AgentEntrySchema.safeParse({
        id: "ops",
        tools: { codeMode: { enabled: true, executor: "quickjs", timeoutMs: 5000 } },
      }).success,
    ).toBe(true);
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({ id: "ops", tools: { codeMode: { languages: ["javascript"] } } }),
      "tools.codeMode",
    );
  });
});
