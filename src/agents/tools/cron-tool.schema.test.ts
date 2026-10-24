import {
  findLlamacppGbnfSchemaViolations,
  normalizeToolParameterSchema,
} from "@openclaw/ai/internal/tool-schema";
import { validateToolArguments } from "@openclaw/llm-core/validation";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronToolSchema } from "./cron-tool-schema.js";
import { createCronTool } from "./cron-tool.js";
import { callGatewayMock, installCronToolTestFixture } from "./cron-tool.test-support.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";

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

const schemaTool = createCronTool();
const schema = schemaTool.parameters;

describe("cron model schema regressions", () => {
  it("omits command edits when management is retained but command jobs are prohibited", () => {
    const restricted = createCronToolSchema({ management: "also", allowCommandJobs: false });
    expect(propertyAt(restricted, "job.payload.kind")?.enum).not.toContain("command");
    expect(propertyAt(restricted, "job.schedule.kind")?.enum).not.toContain("on-exit");
    expect(propertyAt(restricted, "job.payload.argv")).toBeUndefined();
    expect(propertyAt(restricted, "job.schedule.kind")?.enum).toContain("stream");
    expect(propertyAt(restricted, "job.schedule.command")).toBeDefined();
    expect(
      Value.Check(restricted, {
        action: "update",
        jobId: "agent-job",
        job: { payload: { kind: "agentTurn", message: "updated" } },
      }),
    ).toBe(true);
  });

  it("reuses policy-equivalent schemas across sessions and refreshes changed policy", () => {
    const first = createCronToolSchema({ agentSessionKey: "agent:one:main" });
    expect(createCronToolSchema({ agentSessionKey: "agent:two:main" })).toBe(first);
    expect(propertyAt(first, "job.agentId")).toBeUndefined();
    const unscoped = createCronToolSchema();
    expect(unscoped).not.toBe(first);
    expect(propertyAt(unscoped, "job.agentId")).toBeDefined();
    for (const options of [
      { triggersEnabled: false },
      { management: "only" as const },
      { management: "also" as const },
      { selfRemoveOnly: true },
      { readOnly: true },
    ]) {
      const changed = createCronToolSchema(options);
      expect(changed).not.toBe(unscoped);
      expect(changed).not.toEqual(unscoped);
      expect(createCronToolSchema({ ...options })).toBe(changed);
    }
    const recovery = createCronToolSchema({ readOnly: true });
    expect(Value.Check(unscoped, { action: "remove", jobId: "saved-job" })).toBe(true);
    for (const [action, accepted] of [
      ["list", true],
      ["get", true],
      ["status", false],
      ["remove", false],
    ] as const) {
      expect(Value.Check(recovery, { action, jobId: "saved-job" })).toBe(accepted);
    }
  });

  it("does not advertise forbidden automation management inside a scheduled run", () => {
    const restricted = createCronTool({ selfRemoveOnlyJobId: "current", runId: "run-current" });
    expect(restricted.parameters).toHaveProperty("properties.action.enum", [
      "status",
      "list",
      "get",
      "remove",
      "runs",
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
    const active = createCronToolSchema({ selfRemoveOnly: true, activeRun: true });
    const paced = createCronToolSchema({
      selfRemoveOnly: true,
      activeRun: true,
      nextCheckEnabled: true,
    });
    const recovery = createCronToolSchema({
      selfRemoveOnly: true,
      activeRun: true,
      nextCheckEnabled: true,
      readOnly: true,
    });
    for (const action of ["scratch_get", "scratch_set", "record_result"]) {
      expect(Value.Check(restricted.parameters, { action })).toBe(false);
      expect(Value.Check(active, { action })).toBe(true);
      expect(Value.Check(recovery, { action })).toBe(false);
    }
    expect(Value.Check(active, { action: "next_check" })).toBe(false);
    expect(Value.Check(paced, { action: "next_check" })).toBe(true);
    expect(Value.Check(recovery, { action: "next_check" })).toBe(false);
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

  it("preserves failure-alert values in the shared job schema", () => {
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
      const args = { action: "update", job: { failureAlert } };
      const validate = () =>
        validateToolArguments(schemaTool, {
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
    for (const key of [
      "command",
      "cwd",
      "mode",
      "match",
      "batchMs",
      "maxBatchBytes",
      "source",
      "options",
    ]) {
      expect(propertyAt(disabled.parameters, `job.schedule.${key}`)).toBeUndefined();
    }
    for (const key of ["script", "toolBudget"]) {
      expect(propertyAt(disabled.parameters, `job.payload.${key}`)).toBeUndefined();
    }
    expect(disabled.description).toContain("TRIGGERS DISABLED");
    expect(disabled.description).toContain("say it is unsupported");
    expect(disabled.description).not.toContain("TRIGGER (condition watcher");
    expect(disabled.description).not.toContain('kind:"stream"');
    expect(disabled.description).not.toContain('kind:"event"');
    expect(disabled.description).not.toContain('kind:"script"');
  });

  it("keeps the full trigger surface and approval guidance when config omits cron.triggers", () => {
    const defaults = createCronTool({ config: { cron: { enabled: true } } });
    expect(propertyAt(defaults.parameters, "job.trigger.script")).toMatchObject({ type: "string" });
    expect(propertyAt(defaults.parameters, "job.schedule.kind")?.enum).toContain("stream");
    expect(propertyAt(defaults.parameters, "job.payload.kind")?.enum).toContain("script");
    expect(defaults.description).toContain(
      "add/update waits for user approval through the native client",
    );
    expect(defaults.description).toContain(
      "A saved add/update result means any required approval has already completed",
    );
    expect(defaults.description).toContain(
      "Do not ask again or disable the saved stream solely because no user approval reply is visible in chat",
    );
  });
});

installCronToolTestFixture();

describe("cron shorthand and schedule recovery", () => {
  function gatewayCalls() {
    return callGatewayMock.mock.calls.map(([call, options]) => [call.method, options, call.params]);
  }
  const job = {
    name: "reminder",
    schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
    payload: { kind: "agentTurn", message: "work" },
  };
  function execute(args: Record<string, unknown>) {
    return createCronTool().execute("cron", args);
  }
  function expectAdd(params: Record<string, unknown>) {
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
      { method: "cron.add", params: expect.objectContaining(params) },
      expect.anything(),
    );
  }
  function expectUpdate(id: string, patch: Record<string, unknown>, revision?: string) {
    expect(gatewayCalls()).toEqual(
      revision
        ? [
            ["cron.get", expect.anything(), { id }],
            ["cron.update", expect.anything(), { id, expectedConfigRevision: revision, patch }],
          ]
        : [["cron.update", expect.anything(), { id, patch }]],
    );
  }
  function updatePatch() {
    const params = gatewayCalls()[0]?.[2] as { patch?: Record<string, unknown> } | undefined;
    return params?.patch;
  }
  function update(params: Record<string, unknown>) {
    return execute({ action: "update", jobId: "job", ...params });
  }

  describe("cron shorthand recovery", () => {
    it.each(
      (["factory", "host-bound"] as const).flatMap((caller) =>
        (["remove", "update"] as const).flatMap((action) =>
          [false, true].map((retired) => ({ caller, action, retired })),
        ),
      ),
    )(
      "pins $action to the active $caller caller after lookup (retired=$retired)",
      async ({ caller, action, retired }) => {
        let current = true;
        let mutated = false;
        callGatewayMock.mockImplementation(async ({ method }: { method: string }) => {
          if (method === "cron.get") {
            current = !retired;
            return { id: "watcher", configRevision: "sha256:captured" };
          }
          if (method === `cron.${action}`) {
            mutated = true;
            return { ok: true };
          }
          throw new Error(`Unexpected method: ${method}`);
        });
        const identity = {
          agentId: "main",
          sessionKey: "agent:main:watcher-control",
          receiptAuthority: () => current,
        };
        // The harness host binds the admitted caller after a plugin builds its tools.
        const tool = wrapToolWithGatewayCallerIdentity(
          createCronTool(
            caller === "factory"
              ? { agentId: identity.agentId, agentSessionKey: identity.sessionKey }
              : undefined,
          ),
          identity,
        );
        const patch = action === "update" ? { enabled: false } : undefined;
        const mutation = tool.execute("stop-watcher", {
          action,
          jobId: "watcher",
          ...(patch ? { job: patch } : {}),
        });
        if (retired) {
          await expect(mutation).rejects.toThrow("The requesting turn is no longer active.");
          expect(gatewayCalls()).toEqual([["cron.get", expect.anything(), { id: "watcher" }]]);
        } else {
          await expect(mutation).resolves.toMatchObject({ details: { ok: true } });
          expect(gatewayCalls()).toEqual([
            ["cron.get", expect.anything(), { id: "watcher" }],
            [
              `cron.${action}`,
              expect.anything(),
              {
                id: "watcher",
                expectedConfigRevision: "sha256:captured",
                ...(patch ? { patch } : {}),
              },
            ],
          ]);
        }
        expect(mutated).toBe(!retired);
      },
    );

    it("presents list metadata without private job content", () => {
      const presentation = getToolTerminalPresentation(createCronTool());
      if (!presentation) {
        throw new Error("expected terminal presentation");
      }
      const result = {
        content: [],
        details: {
          total: 250,
          jobs: [{ id: "one", name: "private reminder", payload: { text: "secret" } }],
        },
      };
      expect(presentation({ action: "list" }, result)).toEqual({
        text: "Automations listed.\nCount: 250",
      });
      expect(presentation({ action: "add" }, result)).toBeUndefined();
    });

    it("presents watcher execution separately from its saved setting", () => {
      const presentation = getToolTerminalPresentation(createCronTool());
      expect(presentation).toBeTypeOf("function");
      const observed = {
        id: "watcher",
        name: "Application errors",
        schedule: { kind: "stream" },
        enabled: false,
        state: { streamStatus: "error", streamError: "PRIVATE_DIAGNOSTIC" },
      };
      const present = (action: string, details: unknown) =>
        presentation?.({ action }, { content: [], details });
      const uncertain = present("update", observed);
      expect(uncertain?.text).toContain("Paused. Source termination is not confirmed.");
      expect(uncertain?.text).not.toContain("PRIVATE_DIAGNOSTIC");
      expect(present("get", { ...observed, state: { streamStatus: "stopped" } })?.text).toContain(
        "Source termination confirmed.",
      );
      expect(
        present("add", {
          created: true,
          job: { ...observed, enabled: true, state: { streamStatus: "running" } },
        })?.text,
      ).toContain("Source running.");
      expect(present("remove", { ok: true, removed: true })).toBeUndefined();
    });

    it.each([
      {
        name: "script before agent-turn hints",
        input: {
          everyMs: 60_000,
          script: "return { notify: 'changed' }",
          timeoutSeconds: 30,
          toolBudget: 12,
        },
        expected: {
          payload: {
            kind: "script",
            script: "return { notify: 'changed' }",
            timeoutSeconds: 30,
            toolBudget: 12,
          },
        },
      },
      {
        name: "out-of-range timestamp for gateway validation",
        input: { atMs: 8_640_000_000_000_001, message: "report" },
        expected: { schedule: { kind: "at", at: 8_640_000_000_000_001 } },
      },
    ])("recovers $name", async ({ input, expected }) => {
      await execute({ action: "add", name: "reminder", ...input });
      expectAdd(expected);
    });

    const watcherName = "Build watcher";
    const report = { kind: "agentTurn", message: "Report build output" };
    const tail = ["tail", "-F", "/tmp/build.log"];
    it.each<[label: string, args: Record<string, unknown>, error?: string]>([
      [
        "on-exit",
        { action: "add", kind: "on-exit", command: "pnpm build", cwd: "/repo", message: "rebuilt" },
        "automation on-exit schedules cannot be created or edited",
      ],
      ["command-only update", { action: "update", jobId: "job", command: "make" }],
      [
        "flat command without kind",
        {
          action: "add",
          name: watcherName,
          everyMs: 60_000,
          command: tail,
          message: report.message,
        },
      ],
      [
        "nested command without kind",
        {
          action: "add",
          job: {
            name: watcherName,
            schedule: { expr: "* * * * *", command: tail },
            payload: report,
          },
        },
      ],
      [
        "malformed stream",
        {
          action: "add",
          job: {
            name: watcherName,
            schedule: {
              type: "stream",
              command: "/usr/bin/tail -n 0 -F /tmp/build.log",
              pattern: "^BUILD:",
            },
            payload: { type: "send_message", conversationId: "current", template: "{{line}}" },
          },
        },
      ],
    ])(
      "rejects %s before Gateway effects",
      async (_label, args, error = "Read the full automations schema and WATCH OUTPUT example") => {
        await expect(execute(args)).rejects.toThrow(error);
        expect(callGatewayMock).not.toHaveBeenCalled();
      },
    );

    it("loads the current revision before updating a flat trigger", async () => {
      callGatewayMock.mockResolvedValueOnce({
        id: "job",
        configRevision: "sha256:trigger",
        trigger: null,
        payload: { kind: "systemEvent", text: "before" },
      });
      const trigger = { script: "json({ fire: true })", once: false };
      await execute({ action: "update", jobId: "job", trigger });
      expectUpdate("job", { trigger }, "sha256:trigger");
    });

    it("repairs recognized padded keys (#95407)", async () => {
      await execute({
        action: "add",
        job: {
          name: job.name,
          description: "Check-in",
          "schedule ": job.schedule,
          "payload ": job.payload,
          "sessionTarget ": "isolated",
          "enabled ": true,
        },
      });
      expectAdd({ ...job, description: "Check-in", sessionTarget: "isolated", enabled: true });
      for (const key of ["schedule ", "payload ", "sessionTarget ", "enabled "]) {
        expect(gatewayCalls()[0]?.[2]).not.toHaveProperty(key);
      }
    });

    it("does not repair prototype keys (#95407)", async () => {
      await execute({
        action: "add",
        job: { ...job, "__proto__ ": { malicious: true }, "constructor ": "unrecognized" },
      });
      expectAdd({ "__proto__ ": { malicious: true }, "constructor ": "unrecognized" });
    });

    it("preserves canonical/padded conflicts for gateway rejection (#95407)", async () => {
      const conflict = () => ({
        "schedule ": { kind: "every", everyMs: 60_000 },
        enabled: false,
        "enabled ": true,
      });
      await execute({ action: "add", job: { ...job, ...conflict() } });
      expectAdd({ schedule: job.schedule, ...conflict() });
    });

    it.each([
      { "job.payload.message": "after", "job.payload.kind": "agentTurn" },
      { '"job.payload.message"': "after" },
    ])("recovers sibling or quoted dotted keys: %j (#120616)", async (params) => {
      await update(params);
      expect(updatePatch()).toEqual({ payload: { kind: "agentTurn", message: "after" } });
    });

    it("keeps the explicit structured value authoritative over a conflicting dotted key (#120616)", async () => {
      await update({
        payload: { kind: "agentTurn", message: "before" },
        "job.payload.message": "after",
      });

      expect(updatePatch()).toHaveProperty("payload.message", "before");
      expect(updatePatch()).not.toHaveProperty("job.payload.message");
    });

    it.each([
      ["job.name", "nightly.report"],
      ["job.payload.__proto__.polluted", "yes"],
    ])("does not nest scalar or prototype paths: %s (#120616)", async (key, value) => {
      await expect(update({ [key]: value })).rejects.toThrow("job required");
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe("cron schedule updates", () => {
    it("preserves the timezone for flat expressions without leaking scheduleKind", async () => {
      callGatewayMock.mockResolvedValueOnce({
        id: "job-kind",
        configRevision: "sha256:test",
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
      });
      await execute({
        action: "update",
        id: "job-kind",
        expr: "0 8 * * *",
        scheduleKind: "cron",
      });
      expectUpdate(
        "job-kind",
        { schedule: { expr: "0 8 * * *", kind: "cron", tz: "Asia/Shanghai" } },
        "sha256:test",
      );
    });

    it.each([
      { schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Paris" } },
      { schedule: { kind: "every", everyMs: 60_000 } },
      { name: "renamed" },
    ])(
      "updates explicit timezones and unrelated fields without reading the job: %j",
      async (patch) => {
        await execute({ action: "update", id: "job-fast-path", job: patch });
        expectUpdate("job-fast-path", patch);
      },
    );

    it.each([
      { kind: "cron", expr: "0 7 * * *" },
      { kind: "every", everyMs: 60_000 },
    ])("does not invent a timezone when the stored schedule has none: %j", async (schedule) => {
      callGatewayMock.mockResolvedValueOnce({
        id: "job-no-tz",
        configRevision: "sha256:test",
        schedule,
      });
      const patch = { schedule: { kind: "cron", expr: "0 8 * * *" } };
      await execute({ action: "update", id: "job-no-tz", job: patch });
      expectUpdate("job-no-tz", patch, "sha256:test");
    });
  });
});
