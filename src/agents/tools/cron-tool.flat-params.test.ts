// Cron flat-parameter tests cover model-friendly shorthand recovery before
// gateway cron RPC dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  function firstGatewayToolCall<TParams>(): [string, unknown, TParams] {
    const call = callGatewayToolMock.mock.calls[0];
    if (!call) {
      throw new Error("expected callGatewayTool to be called");
    }
    return call as [string, unknown, TParams];
  }

  it("presents read-only cron metadata without job content", () => {
    const tool = createCronTool();
    const terminalPresentation = getToolTerminalPresentation(tool);
    if (!terminalPresentation) {
      throw new Error("expected cron terminal presentation");
    }

    expect(
      terminalPresentation(
        { action: "list" },
        {
          content: [],
          details: {
            total: 2,
            jobs: [
              { id: "one", name: "private reminder", payload: { text: "secret" } },
              { id: "two", name: "another reminder" },
            ],
          },
        },
      ),
    ).toEqual({ text: "Cron jobs listed.\nCount: 2" });
    expect(
      terminalPresentation(
        { action: "list" },
        {
          content: [],
          details: {
            total: 250,
            jobs: [{ id: "one" }, { id: "two" }],
          },
        },
      ),
    ).toEqual({ text: "Cron jobs listed.\nCount: 250" });
    expect(
      terminalPresentation(
        { action: "add" },
        { content: [], details: { id: "three", name: "private reminder" } },
      ),
    ).toBeUndefined();
  });

  it("preserves explicit top-level sessionKey during flat-params recovery", async () => {
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

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{ sessionKey?: string }>();
    expect(method).toBe("cron.add");
    expect(params.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("recovers flat cron schedule shorthand for add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-cron-add", {
      action: "add",
      name: "hourly report",
      cron: "0 * * * *",
      tz: "UTC",
      staggerMs: 5000,
      message: "send report",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      schedule?: unknown;
      payload?: unknown;
    }>();
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      tz: "UTC",
      staggerMs: 5000,
    });
    expect(params.payload).toEqual({
      kind: "agentTurn",
      message: "send report",
    });
  });

  it("passes local cron wall-clock expression and timezone through add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-local-cron-add", {
      action: "add",
      name: "shanghai reminder",
      cron: "0 18 * * *",
      tz: "Asia/Shanghai",
      message: "send reminder",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      schedule?: unknown;
    }>();
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({
      kind: "cron",
      expr: "0 18 * * *",
      tz: "Asia/Shanghai",
    });
  });

  it("leaves out-of-range flat atMs for gateway validation", async () => {
    // The gateway owns final schedule validation; flat recovery should preserve
    // the supplied value instead of silently coercing an invalid date.
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
    const invalidAtMs = 8_640_000_000_000_001;

    await tool.execute("call-flat-invalid-atms-add", {
      action: "add",
      name: "bad date",
      atMs: invalidAtMs,
      message: "send reminder",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      schedule?: { at?: unknown; kind?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({ kind: "at", at: invalidAtMs });
  });

  it("recovers flat cron schedule shorthand for update", async () => {
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
});

// Trailing-space key trimming regression tests for #95407.
import { canonicalizeCronToolObject } from "./cron-tool-canonicalize.js";

describe("cron tool trailing-space key trimming", () => {
  it("trims trailing spaces from recognized cron job keys", () => {
    const result = canonicalizeCronToolObject({
      action: "add",
      job: {
        name: "Test",
        "schedule ": { kind: "cron", expr: "30 10 * * *" },
        "sessionTarget ": "isolated",
        "payload ": { kind: "agentTurn", message: "hello" },
        "enabled ": true,
      },
    });
    expect(result).toHaveProperty("schedule");
    expect(result).toHaveProperty("sessionTarget");
    expect(result).toHaveProperty("payload");
    expect(result).toHaveProperty("enabled");
    expect(Object.keys(result)).not.toContain("schedule ");
    expect(result.schedule).toEqual({ kind: "cron", expr: "30 10 * * *" });
  });

  it("trims leading spaces from recognized cron job keys", () => {
    const result = canonicalizeCronToolObject({
      job: {
        " schedule": { kind: "at", at: "2026-12-25T00:00:00Z" },
        " sessionTarget": "main",
        " payload": { kind: "agentTurn", message: "hi" },
      },
    });
    expect(result).toHaveProperty("schedule");
    expect(result).toHaveProperty("sessionTarget");
    expect(result).toHaveProperty("payload");
    expect(Object.keys(result)).not.toContain(" schedule");
    expect(Object.keys(result)).not.toContain(" sessionTarget");
    expect(Object.keys(result)).not.toContain(" payload");
  });

  it("keeps unknown padded keys unchanged for strict validation to reject", () => {
    const result = canonicalizeCronToolObject({
      job: {
        name: "Test",
        "__proto__ ": { polluted: true },
        schedule: { kind: "cron", expr: "0 * * * *" },
      },
    });
    // Only recognized cron keys are trimmed. Unknown keys stay as-is so
    // strict gateway validation can surface them.
    expect(result).toHaveProperty("schedule");
    // Result is a normal object — no prototype pollution risk.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("preserves a padded duplicate when canonical key already exists", () => {
    const result = canonicalizeCronToolObject({
      job: {
        name: "dup-test",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        "enabled ": true,
        enabled: false,
        payload: { kind: "agentTurn", message: "dup test" },
      },
    });
    // The canonical key already exists — the padded duplicate is preserved
    // so strict validation can reject the conflict instead of silently merging.
    expect(result.enabled).toBe(false);
    expect(result["enabled "]).toBe(true);
  });

  it("does not strip trailing spaces from values, only keys", () => {
    const result = canonicalizeCronToolObject({
      job: {
        "name ": "Test Name ",
        schedule: { kind: "cron", expr: "30 10 * * *" },
      },
    });
    // Key is trimmed ("name " → "name"), value is preserved as-is.
    expect(result.name).toBe("Test Name ");
  });

  it("passes through clean keys unchanged", () => {
    const input: Record<string, unknown> = {
      name: "Holiday Check-in",
      schedule: { kind: "cron", expr: "30 10,20 * * *", tz: "Europe/Madrid" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello" },
      enabled: true,
    };
    const result = canonicalizeCronToolObject(input);
    expect(result).toEqual(input);
  });
});
