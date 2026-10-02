import {
  findLlamacppGbnfSchemaViolations,
  normalizeToolParameterSchema,
} from "@openclaw/ai/internal/tool-schema";
import { validateToolArguments } from "@openclaw/llm-core/validation";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";

function propertyAt(schema: unknown, path: string): Record<string, unknown> | undefined {
  let node = schema as Record<string, unknown> | undefined;
  for (const key of path.split(".")) {
    const variants = node?.anyOf as Array<Record<string, unknown>> | undefined;
    const object = node?.properties ? node : variants?.find((entry) => entry.type === "object");
    const properties = object?.properties as Record<string, Record<string, unknown>> | undefined;
    node = properties?.[key];
  }
  return node;
}

const tool = createCronTool();
const schema = tool.parameters;

describe("cron model schema regressions", () => {
  it("does not advertise forbidden automation management inside a scheduled run", () => {
    const restricted = createCronTool({ selfRemoveOnlyJobId: "current", runId: "run-current" });
    expect(restricted.parameters).toHaveProperty("properties.action.enum", [
      "status",
      "list",
      "get",
      "remove",
      "runs",
      "next_check",
    ]);
    for (const field of ["job", "text", "mode", "runMode", "sessionKey", "contextMessages"]) {
      expect(restricted.parameters).not.toHaveProperty(`properties.${field}`);
    }
    for (const action of ["add", "update", "run", "wake"]) {
      expect(Value.Check(restricted.parameters, { action, jobId: "current" })).toBe(false);
    }
    expect(restricted.description).not.toContain("ADD: job");
    expect(restricted.description).not.toContain("delayed self-wakeups");
    expect(restricted.description).toContain("remove");
  });

  it("advertises timeout clears while retaining numeric bounds", () => {
    for (const [timeoutSeconds, accepted] of [
      [null, true],
      [0, true],
      [0.03, true],
      [30, true],
      [-1, false],
      ["30", false],
    ] as const) {
      expect(
        Value.Check(schema, {
          action: "update",
          id: "timeout-job",
          job: { payload: { timeoutSeconds } },
        }),
      ).toBe(accepted);
    }
  });

  it("keeps declarationKey portable across model schema converters", () => {
    const declarationKey = propertyAt(schema, "job.declarationKey");
    expect(declarationKey).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(declarationKey).not.toHaveProperty("pattern");
  });

  it("projects the complete cron schema into llama.cpp's GBNF subset", () => {
    const projected = normalizeToolParameterSchema(schema, {
      modelCompat: { toolSchemaProfile: "llamacpp" },
    });
    expect(propertyAt(schema, "job.trigger.script")).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 65_536,
    });
    expect(propertyAt(projected, "job.trigger.script")).toEqual({ type: "string", minLength: 1 });
    expect(findLlamacppGbnfSchemaViolations(projected, "cron.parameters")).toEqual([]);
  });

  it.each([undefined, " agent:main:main "])(
    "advertises job retargeting only without session scope (%j)",
    (agentSessionKey) => {
      const parameters = createCronTool({ agentSessionKey, agentId: "main" }).parameters;
      expect(Boolean(propertyAt(parameters, "job.agentId"))).toBe(!agentSessionKey);
      expect(propertyAt(parameters, "agentId")).toMatchObject({ type: "string" });
    },
  );

  it.each(["add", "update"])("preserves failure-alert values for %s", (action) => {
    expect(propertyAt(schema, "job.failureAlert")?.anyOf).toContainEqual({
      type: "boolean",
      const: false,
    });
    for (const [failureAlert, accepted] of [
      [null, true],
      [false, true],
      [{ after: 3, cooldownMs: 0, includeSkipped: true }, true],
      [undefined, true],
      [true, false],
      ["invalid", false],
    ] as const) {
      const args = { action, job: { failureAlert } };
      const validate = () =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "failure-alert",
          name: "automations",
          arguments: args,
        });
      expect(Value.Check(schema, args)).toBe(accepted);
      if (accepted) {
        expect(validate()).toEqual(args);
      } else {
        expect(validate).toThrow(/job.failureAlert/);
      }
    }
  });

  it("projects nullable fields and failure policies into the restricted provider dialect", () => {
    const projected = normalizeToolParameterSchema(schema, { modelProvider: "gemini" });
    expect(propertyAt(projected, "job.failureAlert")).toMatchObject({
      type: "object",
      description: expect.stringContaining("false disables"),
    });
    for (const key of ["job.agentId", "job.sessionKey", "job.payload.model"]) {
      expect(propertyAt(projected, key)).toMatchObject({
        type: "string",
        description: expect.stringMatching(/null to clear/i),
      });
    }
    expect(propertyAt(projected, "job.payload.toolsAllow")).toMatchObject({ type: "array" });
    expect(JSON.stringify(projected)).not.toMatch(/"type"\s*:\s*\[|"not"\s*:\s*\{/);
  });

  it("accepts nullable cron update clears in the runtime schema", () => {
    expect(
      Value.Check(schema, {
        action: "update",
        jobId: "job-1",
        job: {
          agentId: null,
          displayName: null,
          sessionKey: null,
          payload: { toolsAllow: null, model: null, fallbacks: null },
        },
      }),
    ).toBe(true);
  });

  it("describes cron expressions as local wall-clock time in the supplied timezone", () => {
    const expression = propertyAt(schema, "job.schedule.expr")?.description;
    const timezone = propertyAt(schema, "job.schedule.tz")?.description;
    expect(expression).toMatch(/wall-time/i);
    expect(expression).toMatch(/never UTC-convert/i);
    expect(expression).toContain("Gateway local");
    expect(timezone).toMatch(/wall-clock fields/i);
    expect(timezone).toContain("Gateway host local timezone");
  });

  it("omits unavailable trigger capabilities and explains the disabled surface", () => {
    const disabled = createCronTool({ config: { cron: { triggers: { enabled: false } } } });
    expect(propertyAt(disabled.parameters, "job.trigger")).toBeUndefined();
    expect(propertyAt(disabled.parameters, "job.schedule.kind")?.enum).toEqual([
      "at",
      "every",
      "cron",
    ]);
    expect(propertyAt(disabled.parameters, "job.payload.kind")?.enum).toEqual([
      "systemEvent",
      "agentTurn",
    ]);
    for (const key of ["command", "cwd", "mode", "match", "batchMs", "maxBatchBytes"]) {
      expect(propertyAt(disabled.parameters, `job.schedule.${key}`)).toBeUndefined();
    }
    for (const key of ["script", "toolBudget"]) {
      expect(propertyAt(disabled.parameters, `job.payload.${key}`)).toBeUndefined();
    }
    expect(disabled.description).toContain("TRIGGERS DISABLED");
    expect(disabled.description).toContain("say it is unsupported");
    expect(disabled.description).not.toContain("TRIGGER (condition watcher");
    expect(disabled.description).not.toContain('kind:"stream"');
    expect(disabled.description).not.toContain('kind:"script"');
  });

  it("keeps the full surface when config omits cron.triggers", () => {
    const defaults = createCronTool({ config: { cron: { enabled: true } } }).parameters;
    expect(propertyAt(defaults, "job.trigger.script")).toMatchObject({ type: "string" });
    expect(propertyAt(defaults, "job.schedule.kind")?.enum).toContain("stream");
    expect(propertyAt(defaults, "job.payload.kind")?.enum).toContain("script");
  });
});
