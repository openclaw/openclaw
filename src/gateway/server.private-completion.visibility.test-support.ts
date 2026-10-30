import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished } from "vitest";
import { prepareEmbeddedSessionState } from "../agents/command/session-preparation.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { getRuntimeConfig } from "../config/io.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { classifySessionStateActor } from "../sessions/session-state-events.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import type { GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { agentCommandMock, onceMessage, rpcReq } from "./test-helpers.js";

export function registerVisibilityTest(
  getFixture: () => {
    sessionKey: string;
    sessionId: string;
    storePath: string;
    harness: GatewayServerHarness;
    kernel: { gatewayRequestContext: GatewayRequestContext };
    dispatch: () => Promise<unknown>;
  },
) {
  it("keeps private completion deltas hidden through embedded preparation", async () => {
    const { sessionKey, sessionId, storePath, harness, kernel, dispatch } = getFixture();
    const context = kernel.gatewayRequestContext;
    const { ws } = await harness.openClient({ scopes: ["operator.admin"] });
    onTestFinished(() => ws.close());
    expect((await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey })).ok).toBe(true);
    const frames: unknown[] = [];
    ws.on("message", (frame) => frames.push(JSON.parse(rawDataToString(frame))));
    const privateText = "Synthetic private completion";
    const publicText = "Synthetic public reply";
    agentCommandMock.mockImplementation(async (input) => {
      const command = input as AgentCommandOpts;
      await command.userTurnTranscriptRecorder?.persistApproved();
      await command.onExecutionStarted?.();
      const text = command.privateCompletion ? privateText : publicText;
      const currentRunId = expectDefined(command.runId, "admitted run");
      await prepareEmbeddedSessionState({
        cfg: getRuntimeConfig(),
        opts: command,
        sessionKey,
        sessionId: command.sessionId ?? sessionId,
        storePath,
        sessionAgentId: "main",
        lifecycleGeneration: expectDefined(command.lifecycleGeneration, "admitted lifecycle"),
        runId: currentRunId,
        executionWorkspaceDir: expectDefined(command.workspaceDir, "admitted workspace"),
        watchSkills: false,
        isNewSession: false,
        isSubagentLaneTurn: false,
        suppressVisibleSessionEffects: command.sessionEffects === "internal",
        sessionStateActor: classifySessionStateActor(command),
      });
      emitAgentEvent({ runId: currentRunId, stream: "lifecycle", data: { phase: "start" } });
      emitAgentEvent({ runId: currentRunId, stream: "assistant", data: { text, delta: text } });
      emitAgentEvent({ runId: currentRunId, stream: "lifecycle", data: { phase: "end" } });
      return { payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1 } };
    });
    expect(await dispatch()).toMatchObject({ status: "ok" });
    const visible = onceMessage(
      ws,
      (event) => event.type === "event" && JSON.stringify(event).includes(publicText),
    );
    expect(
      await dispatchGatewayMethodInProcess(
        "agent",
        {
          sessionKey,
          idempotencyKey: "ordinary-after-" + sessionId,
          message: "Synthetic public question",
          deliver: false,
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => context,
        },
      ),
    ).toMatchObject({ status: "ok" });
    await visible;
    expect(JSON.stringify(frames)).not.toContain(privateText);
  });
}
