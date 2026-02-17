import { afterEach, describe, expect, test, vi } from "vitest";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

import { callGateway } from "../../gateway/call.js";
import { createDialogTool } from "./dialog-tool.js";

const mockCallGateway = vi.mocked(callGateway);

afterEach(() => {
  vi.resetAllMocks();
});

function parseResult(result: unknown) {
  const r = result as { content?: Array<{ text?: string }> };
  const text = r.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

describe("dialog tool", () => {
  test("returns error when no session key", async () => {
    const tool = createDialogTool({});
    const result = await tool.execute("call-1", {
      questions: [{ id: "q1", prompt: "Name?" }],
    });
    const parsed = parseResult(result);
    expect(parsed.error).toMatch(/no active session/);
  });

  test("returns error when questions is empty", async () => {
    const tool = createDialogTool({ agentSessionKey: "test:key" });
    const result = await tool.execute("call-1", { questions: [] });
    const parsed = parseResult(result);
    expect(parsed.error).toMatch(/questions required/);
  });

  test("starts dialog and sends first question", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    mockCallGateway.mockImplementation(async (opts) => {
      calls.push({ method: opts.method, params: opts.params });
      if (opts.method === "dialog.start") {
        return {
          dialogId: "dlg-123",
          status: "running",
          currentStep: { id: "q1", prompt: "What is your name?" },
          totalSteps: 2,
        } as Record<string, unknown>;
      }
      return {} as Record<string, unknown>;
    });

    const tool = createDialogTool({
      agentSessionKey: "test:key",
      agentChannel: "telegram" as GatewayMessageChannel,
      agentTo: "chat:123",
    });

    const result = await tool.execute("call-1", {
      questions: [
        { id: "q1", prompt: "What is your name?" },
        { id: "q2", prompt: "What is your age?" },
      ],
      intro: "Survey time!",
    });

    const parsed = parseResult(result);
    expect(parsed.status).toBe("started");
    expect(parsed.dialogId).toBe("dlg-123");
    expect(parsed.totalSteps).toBe(2);

    const methods = calls.map((c) => c.method);
    expect(methods).toContain("dialog.start");
    expect(methods).toContain("sessions.patch");
    // intro + first question = 2 send calls
    expect(methods.filter((m) => m === "send")).toHaveLength(2);
  });

  test("skips intro send when no intro provided", async () => {
    const calls: Array<{ method: string }> = [];
    mockCallGateway.mockImplementation(async (opts) => {
      calls.push({ method: opts.method });
      if (opts.method === "dialog.start") {
        return {
          dialogId: "dlg-456",
          status: "running",
          currentStep: { id: "q1", prompt: "Name?" },
          totalSteps: 1,
        } as Record<string, unknown>;
      }
      return {} as Record<string, unknown>;
    });

    const tool = createDialogTool({ agentSessionKey: "test:key" });
    await tool.execute("call-1", {
      questions: [{ id: "q1", prompt: "Name?" }],
    });

    const methods = calls.map((c) => c.method);
    // Only 1 send (first question), no intro send
    expect(methods.filter((m) => m === "send")).toHaveLength(1);
  });

  test("auto-generates step IDs when missing", async () => {
    let startParams: Record<string, unknown> = {};
    mockCallGateway.mockImplementation(async (opts) => {
      if (opts.method === "dialog.start") {
        startParams = opts.params as Record<string, unknown>;
        return {
          dialogId: "dlg-789",
          status: "running",
          currentStep: { id: "step_1", prompt: "Name?" },
          totalSteps: 2,
        } as Record<string, unknown>;
      }
      return {} as Record<string, unknown>;
    });

    const tool = createDialogTool({ agentSessionKey: "test:key" });
    await tool.execute("call-1", {
      questions: [{ prompt: "Name?" }, { id: "", prompt: "Age?" }],
    });

    const steps = startParams.steps as Array<{ id: string }>;
    expect(steps[0].id).toBe("step_1");
    expect(steps[1].id).toBe("step_2");
  });

  test("forwards expiresInMinutes to gateway", async () => {
    let startParams: Record<string, unknown> = {};
    mockCallGateway.mockImplementation(async (opts) => {
      if (opts.method === "dialog.start") {
        startParams = opts.params as Record<string, unknown>;
        return {
          dialogId: "dlg-exp",
          status: "running",
          currentStep: { id: "q1", prompt: "Q?" },
          totalSteps: 1,
        } as Record<string, unknown>;
      }
      return {} as Record<string, unknown>;
    });

    const tool = createDialogTool({ agentSessionKey: "test:key" });
    await tool.execute("call-1", {
      questions: [{ id: "q1", prompt: "Q?" }],
      expiresInMinutes: 30,
    });

    expect(startParams.expiresInMinutes).toBe(30);
  });

  test("still returns success when sessions.patch fails", async () => {
    mockCallGateway.mockImplementation(async (opts) => {
      if (opts.method === "dialog.start") {
        return {
          dialogId: "dlg-patch-fail",
          status: "running",
          currentStep: { id: "q1", prompt: "Q?" },
          totalSteps: 1,
        } as Record<string, unknown>;
      }
      if (opts.method === "sessions.patch") {
        throw new Error("patch failed");
      }
      return {} as Record<string, unknown>;
    });

    const tool = createDialogTool({ agentSessionKey: "test:key" });
    const result = await tool.execute("call-1", {
      questions: [{ id: "q1", prompt: "Q?" }],
    });

    const parsed = parseResult(result);
    expect(parsed.status).toBe("started");
    expect(parsed.dialogId).toBe("dlg-patch-fail");
  });

  test("handles gateway error gracefully", async () => {
    mockCallGateway.mockRejectedValue(new Error("gateway unavailable"));

    const tool = createDialogTool({ agentSessionKey: "test:key" });
    const result = await tool.execute("call-1", {
      questions: [{ id: "q1", prompt: "Name?" }],
    });

    const parsed = parseResult(result);
    expect(parsed.error).toMatch(/gateway unavailable/);
  });
});
