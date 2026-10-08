import { validateToolArguments } from "@openclaw/llm-core/validation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../utils.js";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";

const gateway = vi.fn();
const job = {
  name: "reminder",
  schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
  payload: { kind: "agentTurn", message: "work" },
};
function execute(args: Record<string, unknown>) {
  return createCronTool(undefined, { callGatewayTool: gateway }).execute("cron", args);
}
function validatePrepared(tool: ReturnType<typeof createCronTool>, prepared: unknown) {
  if (!isRecord(prepared)) {
    throw new Error("Expected prepared cron arguments to be an object");
  }
  return validateToolArguments(tool, {
    type: "toolCall",
    id: "cron-boundary",
    name: tool.name,
    arguments: prepared,
  });
}
function expectAdd(params: Record<string, unknown>) {
  expect(gateway).toHaveBeenCalledExactlyOnceWith(
    "cron.add",
    expect.anything(),
    expect.objectContaining(params),
  );
}

beforeEach(() => {
  gateway.mockReset().mockResolvedValue({ ok: true });
});

describe("cron shorthand recovery", () => {
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

  it.each([
    {
      name: "cron with timezone and stagger",
      input: { cron: "0 18 * * *", tz: "Asia/Shanghai", staggerMs: 5000, message: "report" },
      expected: {
        schedule: { kind: "cron", expr: "0 18 * * *", tz: "Asia/Shanghai", staggerMs: 5000 },
        payload: { kind: "agentTurn", message: "report" },
      },
    },
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

  it.each([
    { action: "add", kind: "on-exit", command: "pnpm build", cwd: "/repo", message: "rebuilt" },
    { action: "update", jobId: "job", command: "make" },
  ])("rejects explicit or inferred on-exit shorthand on $action", async (args) => {
    await expect(execute(args)).rejects.toThrow(
      "automation on-exit schedules cannot be created or edited",
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it("loads the current revision before updating a flat trigger", async () => {
    gateway.mockResolvedValueOnce({
      id: "job",
      configRevision: "sha256:trigger",
      trigger: null,
      payload: { kind: "systemEvent", text: "before" },
    });
    const trigger = { script: "json({ fire: true })", once: false };
    await execute({ action: "update", jobId: "job", trigger });
    expect(gateway.mock.calls).toEqual([
      ["cron.get", expect.anything(), { id: "job" }],
      [
        "cron.update",
        expect.anything(),
        { id: "job", expectedConfigRevision: "sha256:trigger", patch: { trigger } },
      ],
    ]);
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
      expect(gateway.mock.calls[0]?.[2]).not.toHaveProperty(key);
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
    await execute({
      action: "add",
      job: {
        ...job,
        "schedule ": { kind: "every", everyMs: 60_000 },
        enabled: false,
        "enabled ": true,
      },
    });
    expectAdd({
      schedule: job.schedule,
      enabled: false,
      "schedule ": { kind: "every", everyMs: 60_000 },
      "enabled ": true,
    });
  });

  it("merges sibling dotted keys under one recovered object (#120616)", async () => {
    // The first field creates the payload object; the second meets that parent
    // and must continue into it instead of being kept as a literal key.
    await execute({
      action: "update",
      jobId: "job-dotted-siblings",
      "job.payload.message": "after",
      "job.payload.kind": "agentTurn",
    });

    const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> };
    expect(params.patch).toEqual({ payload: { kind: "agentTurn", message: "after" } });
  });

  it("keeps the explicit structured value authoritative over a conflicting dotted key (#120616)", async () => {
    // The explicit payload is a valid update on its own. Forwarding the extra
    // dotted key as well made the whole update fail a strict gateway patch, so
    // the canonical value stands and the redundant key is dropped.
    await execute({
      action: "update",
      jobId: "job-dotted-conflict",
      payload: { kind: "agentTurn", message: "before" },
      "job.payload.message": "after",
    });

    const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> };
    expect(params.patch).toHaveProperty("payload.message", "before");
    expect(params.patch).not.toHaveProperty("job.payload.message");
  });

  it("recovers quoted dotted job keys (#120616)", async () => {
    // The report includes literal quote characters around the dotted name.
    await execute({
      action: "update",
      jobId: "job-dotted-quoted",
      '"job.payload.message"': "after",
    });

    const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> };
    expect(params.patch).toEqual({ payload: { kind: "agentTurn", message: "after" } });
  });

  it("does not nest dotted keys rooted at a scalar cron field (#120616)", async () => {
    // Only object-typed cron fields are containers in the gateway schema, so a
    // dot inside a scalar such as a job name stays a plain unrecognized key
    // instead of being reshaped into a path.
    await expect(
      execute({
        action: "update",
        jobId: "job-dotted-name",
        "job.name": "nightly.report",
      }),
    ).rejects.toThrow("job required");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not nest dotted keys that would reach Object.prototype (#120616)", async () => {
    await expect(
      execute({
        action: "update",
        jobId: "job-dotted-proto",
        "job.payload.__proto__.polluted": "yes",
      }),
    ).rejects.toThrow("job required");
    expect(gateway).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("cron flat preparation boundary", () => {
  const callGatewayToolMock = gateway;
  function firstGatewayToolCall<TParams>(): [string, unknown, TParams] {
    const call = gateway.mock.calls[0];
    if (!call) {
      throw new Error("expected Gateway call");
    }
    return call as [string, unknown, TParams];
  }
  it("binds recovered agentTurn jobs to the creating conversation by default", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main:discord:channel:ops" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      sessionKey?: string;
      sessionTarget?: string;
    }>();
    expect(method).toBe("cron.add");
    expect(params.sessionTarget).toBe("current");
    expect(params.sessionKey).toBe("agent:main:discord:channel:ops");
  });

  it("prepares flat add and update calls before schema validation", () => {
    const tool = createCronTool();
    const flatAdd = {
      action: "add",
      job: "truncated",
      name: "daily summary",
      expr: "0 9 * * *",
      tz: "Europe/London",
      message: "Send the summary",
    };
    const preparedAdd = tool.prepareArguments?.(flatAdd);

    expect(preparedAdd).toMatchObject({
      action: "add",
      job: {
        name: "daily summary",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
        payload: { kind: "agentTurn", message: "Send the summary" },
      },
    });
    expect(tool.prepareArguments?.(preparedAdd)).toEqual(preparedAdd);
    expect(
      tool.prepareArguments?.({
        action: "update",
        jobId: "job-123",
        enabled: false,
        everyMs: 300_000,
      }),
    ).toMatchObject({
      action: "update",
      jobId: "job-123",
      job: { enabled: false, schedule: { kind: "every", everyMs: 300_000 } },
    });
  });

  it.each([
    {
      caseName: "one-shot reminder",
      args: {
        action: "add",
        message:
          "Create a cron job named exactly FLATTEST-1 that reminds me to stretch at 2026-08-16T21:29:19Z.",
        name: "FLATTEST-1",
        sessionTarget: "current",
        text: "remind me to stretch at 2026-08-16T21:29:19Z",
      },
    },
    {
      caseName: "recurring reminder",
      args: {
        action: "add",
        message:
          "Create a cron job named exactly FLATTEST-2 that runs every 5 minutes and asks me if I'm still working.",
        name: "FLATTEST-2",
        sessionTarget: "current",
        text: "Are you still working?",
      },
    },
  ])("rejects an ambiguous weak-model $caseName call", ({ args }) => {
    const tool = createCronTool();

    expect(() => tool.prepareArguments?.(args)).toThrow(
      "Send only text (reminder) or only message (task).",
    );
  });

  it('accepts "current" on a corrected weak-model flat add', () => {
    const tool = createCronTool();

    expect(
      tool.prepareArguments?.({
        action: "add",
        name: "FLATTEST-2",
        sessionTarget: "current",
        text: "Are you still working?",
        everyMs: 300_000,
      }),
    ).toMatchObject({
      job: {
        name: "FLATTEST-2",
        sessionTarget: "current",
        schedule: { kind: "every", everyMs: 300_000 },
      },
    });
  });

  it("keeps wake text out of cron job preparation", () => {
    const tool = createCronTool();
    const wake = { action: "wake", text: "check now", mode: "now" };

    expect(tool.prepareArguments?.(wake)).toEqual(wake);
  });

  it("normalizes scalar payload array hints and remains idempotent", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      job: {
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          message: "Run the report",
          toolsAllow: " read ",
          fallbacks: " openai/gpt-5-mini ",
        },
      },
    });

    expect(prepared).toMatchObject({
      job: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read"],
          fallbacks: ["openai/gpt-5-mini"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("repairs a scalar flat toolsAllow before schema validation", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 3_600_000,
      job: "truncated",
      message: "status summary",
      name: "FLATTEST-9",
      text: "status summary",
      toolsAllow: "read",
    });

    expect(prepared).toMatchObject({
      job: {
        name: "FLATTEST-9",
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: {
          kind: "agentTurn",
          message: "status summary",
          toolsAllow: ["read"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("caps an allowed scalar flat toolsAllow to creator authority before dispatch", async () => {
    const tool = createCronTool(
      { creatorToolAllowlist: ["read", "cron"] },
      { callGatewayTool: callGatewayToolMock },
    );

    await tool.execute("call-flat-toolsallow-allowed", {
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-CAP-ALLOWED",
      toolsAllow: "read",
    });

    const [method, , params] = firstGatewayToolCall<{
      payload?: { toolsAllow?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.payload?.toolsAllow).toEqual(["read"]);
  });

  it("strips a scalar flat toolsAllow outside creator authority before dispatch", async () => {
    const tool = createCronTool(
      {
        creatorToolAllowlist: ["read", "cron"],
      },
      { callGatewayTool: callGatewayToolMock },
    );

    await tool.execute("call-flat-toolsallow-unavailable", {
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-CAP-UNAVAILABLE",
      toolsAllow: "write",
    });

    const [method, , params] = firstGatewayToolCall<{
      payload?: { toolsAllow?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.payload?.toolsAllow).toEqual([]);
  });

  it("decodes JSON-encoded nested payload array hints instead of wrapping them", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      job: {
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          message: "Run the report",
          toolsAllow: ' ["read", "web_search"] ',
          fallbacks: '["openai/gpt-5-mini"]',
        },
      },
    });

    expect(prepared).toMatchObject({
      job: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read", "web_search"],
          fallbacks: ["openai/gpt-5-mini"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("decodes JSON-encoded flat array hints instead of wrapping them", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-JSON",
      toolsAllow: '["read"]',
      fallbacks: '["openai/gpt-5-mini", "openai/gpt-5.4"]',
    });

    expect(prepared).toMatchObject({
      job: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read"],
          fallbacks: ["openai/gpt-5-mini", "openai/gpt-5.4"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("caps a JSON-encoded flat toolsAllow to creator authority before dispatch", async () => {
    const tool = createCronTool(
      { creatorToolAllowlist: ["read", "cron"] },
      { callGatewayTool: callGatewayToolMock },
    );

    await tool.execute("call-flat-toolsallow-json", {
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-CAP-JSON",
      toolsAllow: '["read", "write"]',
    });

    const [method, , params] = firstGatewayToolCall<{
      payload?: { toolsAllow?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.payload?.toolsAllow).toEqual(["read"]);
  });

  it("wraps bracketed strings that are not JSON arrays as a single entry", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      job: {
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { message: "Run the report", toolsAllow: "[read" },
      },
    }) as { job?: { payload?: { toolsAllow?: unknown } } };

    expect(prepared.job?.payload?.toolsAllow).toEqual(["[read"]);
  });

  it("preserves blank capability hints for main to treat as unspecified", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      job: {
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { message: "Run the report", toolsAllow: "" },
      },
    }) as { job?: { payload?: { toolsAllow?: unknown } } };

    expect(prepared.job?.payload?.toolsAllow).toBe("");
  });

  it("rejects non-stream top-level mode on add and update calls", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    for (const action of ["add", "update"] as const) {
      for (const mode of ["now", "next-heartbeat"] as const) {
        expect(() => tool.prepareArguments?.({ action, mode })).toThrow(
          '"mode" is only valid for action="wake"',
        );
      }
    }
    for (const args of [
      { action: "add", everyMs: 3_600_000, message: "Run the report", mode: "line" },
      { action: "add", expr: "0 9 * * *", message: "Run the report", mode: "match" },
      { action: "update", id: "job-1", mode: "line" },
    ] as const) {
      expect(() => tool.prepareArguments?.(args)).toThrow('"mode" is only valid for action="wake"');
    }

    const nestedCalls = [
      {
        action: "add",
        mode: "match",
        job: {
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "agentTurn", message: "Run the report" },
        },
      },
      {
        action: "update",
        id: "job-1",
        mode: "now",
        job: { enabled: false },
      },
    ] as const;
    for (const args of nestedCalls) {
      expect(() => tool.prepareArguments?.(args)).toThrow('"mode" is only valid for action="wake"');
      await expect(tool.execute(`call-nested-mode-${args.action}`, args)).rejects.toThrow(
        '"mode" is only valid for action="wake"',
      );
    }
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("preserves unadvertised flat stream recovery without leaking wake mode", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
    for (const mode of ["line", "match"] as const) {
      callGatewayToolMock.mockClear();
      // Stream fields are deliberately absent from the ten-field advertised
      // flat contract. Keep accepting this pre-existing recoverable shape so
      // the mode guard does not regress compatibility providers that emit it.
      const args = {
        action: "add",
        kind: "stream",
        command: ["node", "events.mjs"],
        mode,
        ...(mode === "match" ? { match: "^ready:" } : {}),
        message: "handle events",
      };
      const expectedSchedule = {
        kind: "stream",
        command: ["node", "events.mjs"],
        mode,
        ...(mode === "match" ? { match: "^ready:" } : {}),
      };

      const prepared = tool.prepareArguments?.(args) as Record<string, unknown>;
      expect(prepared).not.toHaveProperty("mode");
      expect(prepared.job).toMatchObject({
        schedule: expectedSchedule,
        payload: { kind: "agentTurn", message: "handle events" },
      });

      await tool.execute(`call-flat-stream-${mode}`, args);
      const [method, _gatewayOpts, params] = firstGatewayToolCall<{
        schedule?: unknown;
        mode?: unknown;
      }>();
      expect(method).toBe("cron.add");
      expect(params).not.toHaveProperty("mode");
      expect(params.schedule).toEqual(expectedSchedule);
    }
  });

  it("rejects conflicting flat add/update schedules without a Gateway write", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
    const conflictingUpdate = {
      action: "update",
      jobId: "job-recurring",
      at: "2026-09-01T09:00:00Z",
      everyMs: 300_000,
    } as const;

    for (const args of [
      { action: "add", name: "S1", at: "2026-09-01T09:00:00Z", everyMs: 300_000, message: "x" },
      {
        action: "add",
        name: "S2",
        at: "2026-09-01T09:00:00Z",
        atMs: 1_800_000_000_000,
        message: "x",
      },
      { action: "add", name: "S3", everyMs: 300_000, expr: "0 * * * *", message: "x" },
      conflictingUpdate,
    ] as const) {
      expect(() => tool.prepareArguments?.(args)).toThrow("Send only one of at, everyMs, or expr.");
    }

    await expect(
      tool.execute("call-flat-schedule-conflict-update", conflictingUpdate),
    ).rejects.toThrow("Send only one of at, everyMs, or expr.");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting flat schedule kind on update before Gateway dispatch", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    for (const args of [
      { action: "update", jobId: "job-recurring", kind: "at", everyMs: 300_000 },
      { action: "update", jobId: "job-recurring", kind: "every", at: "2026-09-01T09:00:00Z" },
      { action: "update", jobId: "job-recurring", kind: "cron", everyMs: 300_000 },
    ] as const) {
      await expect(tool.execute(`call-flat-kind-conflict-${args.kind}`, args)).rejects.toThrow(
        args.kind === "every"
          ? "Use everyMs without at."
          : args.kind === "cron"
            ? "Use expr without everyMs."
            : "Use at without everyMs.",
      );
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting flat scheduleKind alias before Gateway dispatch", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await expect(
      tool.execute("call-flat-schedule-kind-conflict", {
        action: "update",
        jobId: "job-recurring",
        scheduleKind: "every",
        at: "2026-09-01T09:00:00Z",
      }),
    ).rejects.toThrow("Use everyMs without at.");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("accepts a matching flat schedule kind on update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-kind-every", {
      action: "update",
      jobId: "job-recurring",
      kind: "every",
      everyMs: 300_000,
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{ patch?: unknown }>();
    expect(method).toBe("cron.update");
    expect(params.patch).toMatchObject({ schedule: { kind: "every", everyMs: 300_000 } });
  });

  it("rejects flat schedule updates carrying no complete schedule before Gateway dispatch", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    for (const key of [
      "cwd",
      "match",
      "batchMs",
      "maxBatchBytes",
      "exact",
      "staggerMs",
      "anchorMs",
    ] as const) {
      await expect(
        tool.execute(`call-flat-empty-schedule-${key}`, {
          action: "update",
          jobId: "job-recurring",
          [key]:
            key === "exact" ? true : key.endsWith("Bytes") || key.endsWith("Ms") ? 100 : "unused",
        }),
      ).rejects.toThrow("Send a complete expr, at, or everyMs schedule.");
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects flat tz without a cron expression on add", () => {
    const tool = createCronTool();

    expect(() =>
      tool.prepareArguments?.({ action: "add", name: "TZ1", tz: "Europe/London", message: "x" }),
    ).toThrow("tz needs expr. Put the offset in at, or drop tz.");
  });

  it("accepts a cron schedule object with a top-level timezone on add", () => {
    const tool = createCronTool();

    const prepared = tool.prepareArguments?.({
      action: "add",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      tz: "UTC",
      message: "test",
    }) as { job?: { schedule?: unknown } };

    expect(prepared.job?.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  });

  it("infers a cron schedule object kind before accepting top-level timezone on add", () => {
    const tool = createCronTool();

    const prepared = tool.prepareArguments?.({
      action: "add",
      schedule: { expr: "0 9 * * *" },
      tz: "UTC",
      message: "test",
    }) as { job?: { schedule?: unknown } };

    expect(prepared.job?.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  });

  it("keeps rejecting a top-level timezone without a cron schedule on add", () => {
    const tool = createCronTool();

    expect(() => tool.prepareArguments?.({ action: "add", tz: "UTC", message: "test" })).toThrow(
      "tz needs expr. Put the offset in at, or drop tz.",
    );
  });

  it("rejects top-level timezone with a non-cron schedule on add", () => {
    const tool = createCronTool();

    expect(() =>
      tool.prepareArguments?.({
        action: "add",
        everyMs: 3_600_000,
        tz: "UTC",
        message: "test",
      }),
    ).toThrow();
  });

  it.each(["add", "update"])(
    "rejects differing message/text on %s before any Gateway call",
    async (action) => {
      await expect(
        execute({ action, id: "job", everyMs: 300_000, message: "do the thing", text: "stray" }),
      ).rejects.toThrow("Send only text (reminder) or only message (task).");
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("recovers a complete flat cron schedule update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-cron-update", {
      action: "update",
      jobId: "job-123",
      cron: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      id?: string;
      patch?: { schedule?: unknown };
    }>();
    expect(method).toBe("cron.update");
    expect(params.id).toBe("job-123");
    expect(params.patch?.schedule).toEqual({
      kind: "cron",
      expr: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });
  });

  it("rejects incomplete flat schedule updates before Gateway dispatch", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    // The Gateway validates schedule as a complete discriminated union, so a
    // partial patch is rejected there rather than merged into the stored job.
    await expect(
      tool.execute("call-flat-tz-only-update", {
        action: "update",
        jobId: "job-123",
        tz: "Europe/London",
      }),
    ).rejects.toThrow("tz needs expr. Put the offset in at, or drop tz.");

    for (const args of [
      { action: "update", jobId: "job-123", kind: "cron", tz: "Europe/London" },
      { action: "update", jobId: "job-123", kind: "at" },
      { action: "update", jobId: "job-123", kind: "every" },
    ] as const) {
      await expect(tool.execute(`call-flat-incomplete-${args.kind}`, args)).rejects.toThrow(
        "Send a complete expr, at, or everyMs schedule.",
      );
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("accepts a complete flat cron schedule update with a timezone", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-expr-tz-update", {
      action: "update",
      jobId: "job-123",
      expr: "0 9 * * *",
      tz: "Europe/London",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      patch?: { schedule?: unknown };
    }>();
    expect(method).toBe("cron.update");
    expect(params.patch?.schedule).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Europe/London",
    });
  });

  it("prepares dotted payload siblings before schema validation and remains idempotent", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "update",
      jobId: "job-dotted",
      "job.payload.message": "after",
      "job.payload.kind": "agentTurn",
    });
    expect(prepared).toMatchObject({
      job: { payload: { kind: "agentTurn", message: "after" } },
    });
    expect(validatePrepared(tool, prepared)).toMatchObject({
      job: { payload: { kind: "agentTurn", message: "after" } },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it.each([undefined, null, {}, [], "truncated"])(
    "rejects an unrecoverable update job (%j) before any Gateway call",
    async (invalidJob) => {
      await expect(execute({ action: "update", jobId: "job", job: invalidJob })).rejects.toThrow(
        "job required",
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );
});

describe("cron review regression boundaries", () => {
  it.each([false, true])(
    "merges timezone and tool restriction into nested job (JSON=%s)",
    async (json) => {
      const nested = {
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: { kind: "agentTurn", message: "work" },
      };
      const args = {
        action: "add",
        tz: "Europe/London",
        toolsAllow: '["read"]',
        job: json ? JSON.stringify(nested) : nested,
      };
      const tool = createCronTool({ creatorToolAllowlist: ["read"] }, { callGatewayTool: gateway });
      const prepared = tool.prepareArguments?.(args);
      const validated = validatePrepared(tool, prepared);
      expect(tool.prepareArguments?.(validated)).toEqual(prepared);
      expect(nested).not.toHaveProperty("schedule.tz");
      expect(nested).not.toHaveProperty("payload.toolsAllow");
      await tool.execute("nested-flat", validated);
      expectAdd({
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
        payload: expect.objectContaining({ toolsAllow: ["read"] }),
      });
    },
  );

  it.each([
    { tz: "Europe/London", job: { ...job, schedule: { ...job.schedule, tz: "UTC" } }, field: "tz" },
    {
      toolsAllow: ["read"],
      job: { ...job, payload: { ...job.payload, toolsAllow: ["write"] } },
      field: "toolsAllow",
    },
  ])(
    "rejects a conflicting nested/flat $field before any Gateway call",
    async ({ field, ...args }) => {
      await expect(execute({ action: "add", ...args })).rejects.toThrow(
        `${field} is set twice; keep one.`,
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each(["at", "every", "cron"])(
    "rejects an incomplete %s add before any Gateway call",
    async (kind) => {
      await expect(execute({ action: "add", kind, message: "work" })).rejects.toThrow(
        "Add expr, at, or everyMs.",
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("rejects at plus tz with flat-field guidance before any Gateway call", async () => {
    await expect(
      execute({ action: "add", at: "2026-11-01T09:00:00Z", tz: "Europe/London", text: "work" }),
    ).rejects.toThrow("tz needs expr. Put the offset in at, or drop tz.");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("recovers reminder text when message is blank", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 60_000,
      message: "",
      text: "stretch",
    });
    expect(prepared).toMatchObject({ job: { payload: { kind: "systemEvent", text: "stretch" } } });
    expect(tool.prepareArguments?.(validatePrepared(tool, prepared))).toEqual(prepared);
  });

  it.each(["agentTurn", "systemEvent"])(
    "keeps stored %s kind for a text-only update",
    async (kind) => {
      gateway.mockResolvedValueOnce({
        configRevision: "rev",
        payload: { kind, ...(kind === "agentTurn" ? { message: "old" } : { text: "old" }) },
      });
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const prepared = tool.prepareArguments?.({ action: "update", id: "job", text: "new" });
      expect(prepared).toMatchObject({ job: { payload: { text: "new" } } });
      expect(prepared).not.toHaveProperty("job.payload.kind");
      const validated = validatePrepared(tool, prepared);
      expect(tool.prepareArguments?.(validated)).toEqual(prepared);
      await tool.execute("text-edit", validated);
      expect(gateway.mock.calls).toEqual([
        ["cron.get", expect.anything(), { id: "job" }],
        [
          "cron.update",
          expect.anything(),
          {
            id: "job",
            expectedConfigRevision: "rev",
            patch: {
              payload: { kind, ...(kind === "agentTurn" ? { message: "new" } : { text: "new" }) },
            },
          },
        ],
      ]);
    },
  );

  it("rejects unreadable stored payload kind without a write", async () => {
    gateway.mockResolvedValueOnce({ configRevision: "rev", payload: {} });
    await expect(execute({ action: "update", id: "job", text: "new" })).rejects.toThrow(
      "Cannot read the stored job type; retry after fixing the job.",
    );
    expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.get", expect.anything(), { id: "job" });
  });

  it("accepts identical nested/flat timezone and restrictions idempotently", () => {
    const tool = createCronTool();
    const args = {
      action: "add",
      tz: "UTC",
      toolsAllow: ["read"],
      job: { ...job, payload: { ...job.payload, toolsAllow: ["read"] } },
    };
    const prepared = tool.prepareArguments?.(args);
    expect(prepared).toMatchObject({ job: args.job });
    expect(tool.prepareArguments?.(validatePrepared(tool, prepared))).toEqual(prepared);
  });

  it("recovers text as the message of an explicit nested task without losing it", () => {
    const tool = createCronTool();
    const args = {
      action: "add",
      text: "new",
      job: { schedule: job.schedule, payload: { kind: "agentTurn" } },
    };
    const prepared = tool.prepareArguments?.(args);
    expect(prepared).toMatchObject({ job: { payload: { kind: "agentTurn", message: "new" } } });
    expect(tool.prepareArguments?.(validatePrepared(tool, prepared))).toEqual(prepared);
  });

  it("guides an unambiguous schedule-less task before any Gateway call", async () => {
    await expect(execute({ action: "add", message: "work" })).rejects.toThrow(
      "Add expr, at, or everyMs.",
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["command", "script"])(
    "rejects a text-only edit to a stored %s without a write",
    async (kind) => {
      gateway.mockResolvedValueOnce({ configRevision: "rev", payload: { kind } });
      await expect(execute({ action: "update", id: "job", text: "new" })).rejects.toThrow(
        "text edits need a reminder or task job.",
      );
      expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.get", expect.anything(), { id: "job" });
    },
  );
});
