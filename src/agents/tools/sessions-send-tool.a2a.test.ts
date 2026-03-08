import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
const runAgentStepMock = vi.fn();
const resolveAnnounceTargetMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./agent-step.js", () => ({
  readLatestAssistantReply: (params: unknown) => readLatestAssistantReplyMock(params),
  runAgentStep: (params: unknown) => runAgentStepMock(params),
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: (params: unknown) => resolveAnnounceTargetMock(params),
}));

import { FileExecutionGraphStateStoreV0 } from "../execution-graph/state-store-v0.js";
import { SESSIONS_SEND_A2A_GRAPH_ID_V0, runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const tempDirs: string[] = [];

afterEach(() => {
  callGatewayMock.mockReset();
  readLatestAssistantReplyMock.mockReset();
  runAgentStepMock.mockReset();
  resolveAnnounceTargetMock.mockReset();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup for test temp dir
    }
  }
});

beforeEach(() => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-graph-a2a-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

describe("runSessionsSendA2AFlow execution graph v0", () => {
  it("persists graph node state and avoids duplicate delivery on deterministic replay", async () => {
    vi.stubEnv("OPENCLAW_EXECUTION_GRAPH_V0", "1");

    callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "send") {
        return { status: "ok" };
      }
      throw new Error(`Unexpected gateway method: ${String(request.method)}`);
    });

    readLatestAssistantReplyMock.mockResolvedValue("round-one-reply");
    runAgentStepMock.mockResolvedValue("announce-from-graph");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "discord",
      to: "channel:dev",
      accountId: "default",
    });

    const params = {
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "hello",
      announceTimeoutMs: 5000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "discord" as const,
      waitRunId: "wait-run-123",
    };

    await runSessionsSendA2AFlow(params);

    const firstSendCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string } | undefined)?.method === "send",
    );
    expect(firstSendCalls).toHaveLength(1);

    const store = new FileExecutionGraphStateStoreV0(process.env);
    const persisted = store.load({
      graphId: SESSIONS_SEND_A2A_GRAPH_ID_V0,
      runId: "wait-run-123",
    });
    expect(persisted).toBeDefined();
    expect(persisted?.nodeStates.resolve_round_one_reply).toMatchObject({
      status: "succeeded",
      planVersion: "sessions-send-a2a/graph-v0",
    });
    expect(persisted?.nodeStates.resolve_round_one_reply.inputsHash.length).toBe(64);
    expect(typeof persisted?.nodeStates.resolve_round_one_reply.outputsSummary).toBe("string");

    callGatewayMock.mockClear();
    readLatestAssistantReplyMock.mockClear();
    runAgentStepMock.mockClear();
    resolveAnnounceTargetMock.mockClear();

    await runSessionsSendA2AFlow(params);

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
    expect(runAgentStepMock).not.toHaveBeenCalled();
    expect(resolveAnnounceTargetMock).not.toHaveBeenCalled();
  });
});
