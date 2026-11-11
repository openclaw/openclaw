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
    ]) {
      const changed = createCronToolSchema(options);
      expect(changed).not.toEqual(unscoped);
      expect(createCronToolSchema({ ...options })).toBe(changed);
    }
    expect(Value.Check(unscoped, { action: "remove", jobId: "saved-job" })).toBe(true);
  });

  it("does not advertise forbidden automation management inside a scheduled run", () => {
    const restricted = createCronTool({
      agentSessionKey: "agent:main:cron:current",
      selfRemoveOnlyJobId: "current",
      runId: "run-current",
    });
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
    expect(restricted.description).not.toContain("ADD: job");
    expect(restricted.description).not.toContain("delayed self-wakeups");
    expect(restricted.description).toContain("remove");
    const active = createCronToolSchema({ selfRemoveOnly: true, activeRun: true });
    const paced = createCronToolSchema({
      selfRemoveOnly: true,
      activeRun: true,
      nextCheckEnabled: true,
    });
    for (const action of ["scratch_get", "scratch_set", "record_result"]) {
      expect(Value.Check(restricted.parameters, { action })).toBe(false);
      expect(Value.Check(active, { action })).toBe(true);
    }
    expect(Value.Check(active, { action: "next_check" })).toBe(false);
    expect(Value.Check(paced, { action: "next_check" })).toBe(true);
  });

  it("keeps conversation definitions stable while scheduled calls stay self-scoped", async () => {
    const agentSessionKey = "agent:main:prefix-proof";
    const user = createCronTool({ agentSessionKey });
    const scheduled = createCronTool({
      agentSessionKey,
      selfRemoveOnlyJobId: "current",
      runId: "run-current",
    });
    expect(scheduled.description).toBe(user.description);
    expect(scheduled.parameters).toEqual(user.parameters);
    for (const action of ["scratch_get", "scratch_set", "record_result", "next_check"]) {
      expect(Value.Check(user.parameters, { action })).toBe(true);
      await expect(user.execute(action, { action })).rejects.toThrow(
        /only available (?:inside|to) the currently running/,
      );
    }
    for (const action of ["add", "update", "run", "wake"]) {
      const args = { action, jobId: "current" };
      expect(Value.Check(scheduled.parameters, args)).toBe(true);
      await expect(scheduled.execute(action, args)).rejects.toThrow(
        "Automations tool is restricted to the current automation.",
      );
    }
    await expect(
      scheduled.execute("other-job", { action: "remove", jobId: "other" }),
    ).rejects.toThrow("Automations tool is restricted to the current automation.");
    expect(callGatewayMock).not.toHaveBeenCalled();
    await scheduled.execute("own-job", { action: "remove", jobId: "current" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      { method: "cron.remove", params: { id: "current" } },
      expect.anything(),
    );
  });

  it("advertises timeout clears while retaining numeric bounds", () => {
    for (const [timeoutSeconds, accepted] of [
      [null, true],
      [0, true],
      [0.03, true],
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

  it("projects portable job keys and the complete schema into llama.cpp's GBNF subset", () => {
    const declarationKey = propertyAt(schema, "job.declarationKey");
    expect(declarationKey).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(declarationKey).not.toHaveProperty("pattern");
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
    for (const [failureAlert, accepted] of [
      [null, true],
      [false, true],
      [{ after: 3, cooldownMs: 0, includeSkipped: true }, true],
      [undefined, true],
      [true, false],
    ] as const) {
      const args = { action: "update", job: { failureAlert } };
      const validate = () =>
        validateToolArguments(schemaTool, {
          type: "toolCall",
          id: "failure-alert",
          name: "automations",
          arguments: args,
        });
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
    for (const key of ["command", "source"]) {
      expect(propertyAt(disabled.parameters, `job.schedule.${key}`)).toBeUndefined();
    }
    for (const key of ["script", "toolBudget"]) {
      expect(propertyAt(disabled.parameters, `job.payload.${key}`)).toBeUndefined();
    }
    expect(disabled.description).toContain("TRIGGERS DISABLED");
    expect(disabled.description).toContain("say it is unsupported");
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
  function presentation() {
    const present = getToolTerminalPresentation(createCronTool());
    expect(present).toBeTypeOf("function");
    return (action: string, details: unknown) => present?.({ action }, { content: [], details });
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
        } else {
          await expect(mutation).resolves.toMatchObject({ details: { ok: true } });
          expect(callGatewayMock).toHaveBeenLastCalledWith(
            {
              method: `cron.${action}`,
              params: {
                id: "watcher",
                expectedConfigRevision: "sha256:captured",
                ...(patch ? { patch } : {}),
              },
            },
            expect.anything(),
          );
        }
        expect(mutated).toBe(!retired);
      },
    );

    it("presents list metadata without private job content", () => {
      const present = presentation();
      const details = {
        total: 250,
        jobs: [{ id: "one", name: "private reminder", payload: { text: "secret" } }],
      };
      expect(present("list", details)).toEqual({ text: "Automations listed.\nCount: 250" });
      expect(present("add", details)).toBeUndefined();
    });

    it("presents watcher execution separately from its saved setting", () => {
      const present = presentation();
      const observed = {
        id: "watcher",
        name: "Application errors",
        schedule: { kind: "stream" },
        enabled: false,
        state: { streamStatus: "error", streamError: "PRIVATE_DIAGNOSTIC" },
      };
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

    const script = { script: "return { notify: 'changed' }", timeoutSeconds: 30, toolBudget: 12 };
    it.each([
      {
        name: "script before agent-turn hints",
        input: { everyMs: 60_000, ...script },
        expected: { payload: { kind: "script", ...script } },
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

    it.each<[label: string, args: Record<string, unknown>, error?: string]>([
      [
        "on-exit",
        { action: "add", kind: "on-exit", command: "pnpm build" },
        "automation on-exit schedules cannot be created or edited",
      ],
      ["command-only update", { action: "update", jobId: "job", command: "make" }],
      ["flat command without kind", { action: "add", everyMs: 60_000, command: ["tail"] }],
      ["nested command without kind", { action: "add", job: { schedule: { command: ["tail"] } } }],
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
        job: { schedule: job.schedule, "payload ": job.payload },
      });
      expectAdd({ schedule: job.schedule, payload: job.payload });
      expect(gatewayCalls()[0]?.[2]).not.toHaveProperty("payload ");
    });

    it("does not repair prototype keys (#95407)", async () => {
      await execute({
        action: "add",
        job: { ...job, "__proto__ ": { malicious: true } },
      });
      expectAdd({ "__proto__ ": { malicious: true } });
    });

    it("preserves canonical/padded conflicts for gateway rejection (#95407)", async () => {
      const conflict = { "payload ": { kind: "systemEvent", text: "conflict" } };
      await execute({ action: "add", job: { ...job, ...conflict } });
      expectAdd({ payload: job.payload, ...conflict });
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
