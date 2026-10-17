import { validateToolArguments } from "@openclaw/llm-core/validation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { isRecord } from "../../utils.js";
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
  setRuntimeConfigSnapshot({});
  gateway.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("cron review regression boundaries", () => {
  it.each([
    {
      example: '{ "action":"add", "everyMs":300000, "message":"Check for urgent mail" }',
      method: "cron.add",
      expected: {
        schedule: { kind: "every", everyMs: 300000 },
        payload: { kind: "agentTurn", message: "Check for urgent mail" },
      },
    },
    {
      example:
        '{ "action":"add", "expr":"0 9 * * *", "tz":"Europe/London", "text":"Take a break" }',
      method: "cron.add",
      expected: {
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
        payload: { kind: "systemEvent", text: "Take a break" },
      },
    },
    {
      example: '{ "action":"update", "jobId":"existing-job-id", "enabled":false }',
      method: "cron.update",
      expected: { id: "existing-job-id", patch: { enabled: false } },
    },
  ])("executes the verbatim prompt example: $example", async ({ example, method, expected }) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    expect(tool.description).toContain(example);
    const prepared = tool.prepareArguments?.(JSON.parse(example));
    const validated = validatePrepared(tool, prepared);
    await tool.execute("prompt-example", validated);
    expect(gateway).toHaveBeenCalledExactlyOnceWith(
      method,
      expect.anything(),
      expect.objectContaining(expected),
    );
  });

  it.each(["", "   "])("ignores blank flat fillers %j beside a nested job", async (blank) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = {
      action: "add",
      job,
      at: blank,
      everyMs: blank,
      expr: blank,
      tz: blank,
      message: blank,
      name: blank,
      enabled: blank,
      sessionTarget: blank,
      toolsAllow: blank,
      text: blank,
    };
    const prepared = tool.prepareArguments?.(args);
    expect(prepared).toEqual({ action: "add", job });
    expect(args.tz).toBe(blank);
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
    await tool.execute("nested-blank-fillers", validatePrepared(tool, prepared));
    expectAdd({ schedule: job.schedule, payload: job.payload });
  });

  it("accepts a nested at reminder with a blank schedule timezone", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const nested = {
      name: "stretch",
      sessionTarget: "main",
      schedule: { kind: "at", at: "2026-11-01T09:00:00Z", tz: "" },
      payload: { kind: "systemEvent", text: "stretch" },
    };
    const prepared = tool.prepareArguments?.({ action: "add", job: nested });
    expect(prepared).toEqual({ action: "add", job: nested });
    await tool.execute("nested-stretch-blank-tz", validatePrepared(tool, prepared));
    expectAdd({
      name: "stretch",
      sessionTarget: "main",
      schedule: { kind: "at", at: "2026-11-01T09:00:00.000Z" },
      payload: { kind: "systemEvent", text: "stretch" },
    });
    expect(gateway.mock.calls[0]?.[2].schedule).not.toHaveProperty("tz");
  });

  it("continues ignoring cosmetic flat name beside a nested job", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = { action: "add", name: "ignored flat name", job };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-flat-name", validatePrepared(tool, args));
    expectAdd({ name: job.name, schedule: job.schedule, payload: job.payload });
  });

  it.each(["add", "update"])(
    "rejects an empty %s wrapper with no flat content before Gateway dispatch",
    async (action) => {
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const prepared = tool.prepareArguments?.({ action, id: "job", job: {} });
      await expect(tool.execute("empty-wrapper", validatePrepared(tool, prepared))).rejects.toThrow(
        "job required",
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each(["add", "update"])("recovers flat content from an empty %s wrapper", async (action) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const prepared = tool.prepareArguments?.({
      action,
      id: "job",
      job: {},
      ...(action === "add" ? { everyMs: 60_000, text: "stretch" } : { enabled: false }),
    });
    expect(prepared).not.toHaveProperty("everyMs");
    expect(prepared).not.toHaveProperty("text");
    expect(prepared).not.toHaveProperty("enabled");
    const validated = validatePrepared(tool, prepared);
    expect(tool.prepareArguments?.(validated)).toEqual(prepared);
    await tool.execute("empty-flat-wrapper", validated);
    expect(gateway).toHaveBeenCalledTimes(1);
    if (action === "add") {
      expectAdd({
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", text: "stretch" },
      });
    } else {
      expect(gateway).toHaveBeenCalledWith("cron.update", expect.anything(), {
        id: "job",
        patch: { enabled: false },
      });
    }
  });

  it("ignores top-level wake mode beside a nested update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = { action: "update", id: "job", mode: "now", job: { enabled: false } };
    const prepared = tool.prepareArguments?.(args);
    expect(prepared).toEqual(args);
    await tool.execute("nested-mode", validatePrepared(tool, prepared));
    expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.update", expect.anything(), {
      id: "job",
      patch: { enabled: false },
    });
  });

  it("continues ignoring unadvertised aliases beside a nested job", async () => {
    const args = {
      action: "add",
      job,
      cron: "0 1 * * *",
      every: 123,
      atMs: 123,
      "payload.toolsAllow": ["write"],
    };
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-aliases", args);
    expectAdd({ schedule: job.schedule, payload: job.payload });
  });

  it.each(["", "   "])("treats blank flat tz %j as absent through execute", async (tz) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const prepared = tool.prepareArguments?.({
      action: "add",
      at: "2026-11-01T09:00:00Z",
      tz,
      text: "stretch",
    });
    await tool.execute("blank-tz", validatePrepared(tool, prepared));
    expectAdd({ schedule: { kind: "at", at: "2026-11-01T09:00:00.000Z" } });
  });

  it("normalizes stale nested at fields through the normal execute route", async () => {
    // Same stale schedule shape as src/cron/normalize.test.ts:STALE_AT_SCHEDULE.
    const schedule = {
      kind: "at",
      at: "2026-01-12T18:00:00Z",
      expr: "* * * * *",
      everyMs: 60_000,
      anchorMs: 123,
      tz: "UTC",
      staggerMs: 30_000,
    };
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = { action: "add", job: { ...job, schedule } };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-stale-at", validatePrepared(tool, tool.prepareArguments?.(args)));
    expectAdd({ schedule: { kind: "at", at: "2026-01-12T18:00:00.000Z" } });
  });

  it("leaves nested agentTurn leftover text to normal normalization", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = {
      action: "add",
      job: { ...job, payload: { kind: "agentTurn", message: "work", text: "leftover" } },
    };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute(
      "nested-leftover-text",
      validatePrepared(tool, tool.prepareArguments?.(args)),
    );
    expectAdd({ payload: { kind: "agentTurn", message: "work" } });
  });

  it("leaves nested reminder leftover message to normal normalization", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = {
      action: "add",
      job: { ...job, payload: { kind: "systemEvent", text: "stretch", message: "leftover" } },
    };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute(
      "nested-leftover-message",
      validatePrepared(tool, tool.prepareArguments?.(args)),
    );
    expectAdd({ payload: { kind: "systemEvent", text: "stretch" } });
  });

  it.each([false, true])(
    "rejects nested jobs with advertised flat timezone and restrictions (JSON=%s)",
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
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const error =
        "Do not mix job with flat fields: tz, toolsAllow. Retry with job only, or remove job and send all intended settings as flat fields.";
      expect(() => tool.prepareArguments?.(args)).toThrow(error);
      await expect(tool.execute("nested-flat", args)).rejects.toThrow(error);
      expect(nested).not.toHaveProperty("schedule.tz");
      expect(nested).not.toHaveProperty("payload.toolsAllow");
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["at", "2026-11-01T09:00:00Z"],
    ["everyMs", 60_000],
    ["expr", "0 12 * * *"],
    ["tz", "UTC"],
    ["message", "work"],
    ["enabled", false],
    ["sessionTarget", "isolated"],
    ["toolsAllow", ["read"]],
    ["text", "stretch"],
  ] as const)(
    "rejects advertised flat %s beside a nonempty job on add and update",
    async (field, value) => {
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      for (const action of ["add", "update"]) {
        const args = { action, id: "job", job, [field]: value };
        const error = `Do not mix job with flat fields: ${field}. Retry with job only, or remove job and send all intended settings as flat fields.`;
        expect(() => tool.prepareArguments?.(args)).toThrow(error);
        await expect(tool.execute("mixed-field", args)).rejects.toThrow(error);
      }
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

  it.each([
    ["agentTurn", false],
    ["systemEvent", false],
    ["agentTurn", true],
    ["systemEvent", true],
  ] as const)(
    "updates stored %s job end to end without changing kind (nested=%s)",
    async (kind, nested) => {
      gateway.mockResolvedValueOnce({
        configRevision: "rev",
        payload: { kind, ...(kind === "agentTurn" ? { message: "old" } : { text: "old" }) },
      });
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const prepared = tool.prepareArguments?.({
        action: "update",
        id: "job",
        ...(nested ? { job: { payload: { text: "new" } } } : { text: "new" }),
      });
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

  it.each([false, true])(
    "rejects unreadable stored payload kind without a write (nested=%s)",
    async (nested) => {
      gateway.mockResolvedValueOnce({ configRevision: "rev", payload: {} });
      await expect(
        execute({
          action: "update",
          id: "job",
          ...(nested ? { job: { payload: { text: "new" } } } : { text: "new" }),
        }),
      ).rejects.toThrow(
        "Cannot read whether the existing job is a reminder or task. No changes saved. Ask an administrator to inspect the existing job; do not recreate it.",
      );
      expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.get", expect.anything(), { id: "job" });
    },
  );

  it("rejects identical nested/flat timezone and restrictions", async () => {
    await expect(
      execute({
        action: "add",
        tz: "UTC",
        toolsAllow: ["read"],
        job: { ...job, payload: { ...job.payload, toolsAllow: ["read"] } },
      }),
    ).rejects.toThrow(
      "Do not mix job with flat fields: tz, toolsAllow. Retry with job only, or remove job and send all intended settings as flat fields.",
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it("rejects top-level text beside an explicit nested task", async () => {
    await expect(
      execute({
        action: "add",
        text: "new",
        job: { schedule: job.schedule, payload: { kind: "agentTurn" } },
      }),
    ).rejects.toThrow(
      "Do not mix job with flat fields: text. Retry with job only, or remove job and send all intended settings as flat fields.",
    );
    expect(gateway).not.toHaveBeenCalled();
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
        "Use text only to edit a reminder or task job.",
      );
      expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.get", expect.anything(), { id: "job" });
    },
  );
});
