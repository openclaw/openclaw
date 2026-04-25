import { describe, expect, it, vi } from "vitest";
import type { GatewayCallOptions } from "./gateway.js";
import { createSessionsSleepTool } from "./sessions-sleep-tool.js";

describe("sessions_sleep tool", () => {
  function createTool(params?: {
    sessionKey?: string;
    nowMs?: number;
    calls?: unknown[];
    listJobs?: unknown[];
  }) {
    const calls = params?.calls ?? [];
    const callGatewayTool = async <T = Record<string, unknown>>(
      method: string,
      _opts: GatewayCallOptions,
      payload?: unknown,
    ): Promise<T> => {
      calls.push({ method, payload });
      if (method === "cron.list") {
        return { jobs: params?.listJobs ?? [] } as T;
      }
      if (method === "cron.update") {
        return { id: "job-existing", ...(payload as Record<string, unknown>) } as T;
      }
      return { id: "job-new", ...(payload as Record<string, unknown>) } as T;
    };
    const tool = createSessionsSleepTool(
      {
        agentSessionKey: params?.sessionKey ?? "agent:main:telegram:default:direct:test-user",
        config: { session: { mainKey: "main" } },
      },
      {
        callGatewayTool,
        nowMs: () => params?.nowMs ?? 1_000,
      },
    );
    return { tool, callGatewayTool, calls };
  }

  it("schedules a lightweight current-session one-shot wake", async () => {
    const { tool, calls } = createTool({ nowMs: 10_000 });
    const result = await tool.execute("call-1", {
      wakeAfterSeconds: 600,
      message: "Continue Ask Pro run askpro_1.",
      dedupeKey: "askpro:askpro_1",
      toolsAllow: ["browser", "message", "sessions_sleep"],
    });

    expect(result.details).toMatchObject({
      status: "scheduled",
      action: "created",
      wakeAfterSeconds: 600,
      dedupeKey: "askpro:askpro_1",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "cron.list",
      payload: { includeDisabled: true, limit: 200, query: "askpro:askpro_1" },
    });
    expect(calls[1]).toMatchObject({
      method: "cron.add",
      payload: {
        name: "Session sleep: askpro:askpro_1",
        description: "openclaw:sessions_sleep:askpro:askpro_1",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: "1970-01-01T00:10:10.000Z" },
        sessionTarget: "session:agent:main:telegram:default:direct:test-user",
        wakeMode: "now",
        sessionKey: "agent:main:telegram:default:direct:test-user",
        agentId: "main",
        payload: {
          kind: "agentTurn",
          message: "Continue Ask Pro run askpro_1.",
          timeoutSeconds: 900,
          lightContext: true,
          toolsAllow: ["browser", "message", "sessions_sleep"],
        },
        delivery: { mode: "none" },
        failureAlert: false,
      },
    });
  });

  it("refreshes an existing deduped sleep instead of adding a duplicate", async () => {
    const { tool, calls } = createTool({
      listJobs: [{ id: "job-existing", description: "openclaw:sessions_sleep:askpro:askpro_1" }],
    });

    const result = await tool.execute("call-1", {
      wakeAfterSeconds: 300,
      message: "Check again.",
      dedupeKey: "askpro:askpro_1",
    });

    expect(result.details).toMatchObject({
      status: "scheduled",
      action: "updated",
      dedupeKey: "askpro:askpro_1",
    });
    expect(calls.map((call) => (call as { method: string }).method)).toEqual([
      "cron.list",
      "cron.update",
    ]);
    expect(calls[1]).toMatchObject({
      payload: {
        id: "job-existing",
        patch: {
          schedule: { kind: "at", at: "1970-01-01T00:05:01.000Z" },
          payload: {
            kind: "agentTurn",
            message: "Check again.",
            timeoutSeconds: 900,
            lightContext: true,
          },
        },
      },
    });
  });

  it("returns an error when no current session exists", async () => {
    const callGatewayMock = vi.fn();
    const callGatewayTool = async <T = Record<string, unknown>>(
      method: string,
      gatewayOpts: GatewayCallOptions,
      payload?: unknown,
    ): Promise<T> => {
      callGatewayMock(method, gatewayOpts, payload);
      return {} as T;
    };
    const tool = createSessionsSleepTool({}, { callGatewayTool });
    const result = await tool.execute("call-1", {
      wakeAfterSeconds: 60,
      message: "Wake up.",
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "No session context",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns a structured error for invalid sleep params", async () => {
    const { tool, calls } = createTool();
    const result = await tool.execute("call-1", {
      message: "Wake up.",
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "wakeAfterSeconds required",
    });
    expect(calls).toHaveLength(0);
  });
});
