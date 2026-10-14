import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type MockInstance } from "vitest";
import { createHostWorkspaceWriteTool } from "../agents/agent-tools.read.js";
import { createExecTool } from "../agents/bash-tools.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import { getRuntimeConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createTalkClientAgentConsultRunner } from "./talk/client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "./talk/client-gateway-control.js";
import { retainTalkClientRunAuthority } from "./talk/client-run-authority.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";
import { prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

/** Uses the history suite's existing Gateway, transcript state, and model seam. */
export async function runTalkNativeActionParity({
  context,
  client,
  agentId,
  sessionKey,
  canonicalKey,
  sessionId,
  storePath,
  voiceSessionId,
  connectionId,
  runEmbeddedAgent,
  rpc,
  consult,
  waitForDispatchEnd,
}: {
  context: GatewayRequestContext;
  client: GatewayClient;
  agentId: string;
  sessionKey: string;
  canonicalKey: string;
  sessionId: string;
  storePath: string;
  voiceSessionId: string | undefined;
  connectionId: string;
  runEmbeddedAgent: MockInstance<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  consult: (question: string, callId: string) => Promise<Record<string, unknown>>;
  waitForDispatchEnd: () => Promise<void>;
}) {
  const scope = () => ({ agentId, sessionKey: canonicalKey, sessionId, storePath });
  const config = getRuntimeConfig();
  await prepareGatewayReplyRuntimeForTest({
    force: true,
    config: { ...config, tools: { ...config.tools, exec: { host: "gateway", mode: "full" } } },
  });
  await replaceSessionEntry(scope(), {
    sessionId,
    updatedAt: Date.now(),
    permissionMode: "full",
    execHost: "gateway",
  });
  const results: unknown[] = [];
  const prepared: unknown[] = [];
  let marker: string | undefined;
  const resetWriteMarker = () =>
    fs.rm(
      path.join(path.dirname(expectDefined(marker, "native effect file")), "voice-parity-note.txt"),
      { force: true },
    );
  runEmbeddedAgent.mockImplementation(async (params) => {
    const admission = expectDefined(params.preparedRunAdmission, "real ingress admission");
    const admittedRunContext = await admission.admit("plugin-harness", "parity-test-model");
    prepared.push({
      principal: admission.readOperatorAuthority?.()?.profileId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      sessionRoot: params.sessionRoot,
      execOverrides: params.execOverrides,
      bashElevated: params.bashElevated,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
      messageProvider: params.messageProvider,
      messageChannel: params.messageChannel,
      carriesControlAuthority: Object.hasOwn(params, "operatorAuthority"),
      approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    });
    const host = createAgentHarnessHostCapabilities({
      pluginId: "parity-test-model",
      attempt: {
        agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
        cwd: params.cwd,
        config: params.config,
        admittedRunContext,
      },
    });
    const policy = projectEffectiveExecPolicy({
      base: { host: "gateway", mode: "full" },
      overrides: params.execOverrides,
      permissionPolicy: { mode: params.permissionMode ?? "read-only" },
    });
    marker = path.join(params.workspaceDir, "voice-parity-effects");
    const [tool, writeTool] = host.capabilities.bindToolSurface([
      createExecTool({
        ...policy,
        config: params.config,
        cwd: params.workspaceDir,
        agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        allowBackground: false,
      }),
      createHostWorkspaceWriteTool(params.workspaceDir),
    ]);
    try {
      const result = await expectDefined(tool, "bound native exec").execute("same-model-action", {
        command: "printf 'effect\n' >> voice-parity-effects",
        workdir: params.workspaceDir,
        yieldMs: 10000,
      });
      const written = await expectDefined(writeTool, "bound filesystem action").execute(
        "same-write-action",
        { path: "voice-parity-note.txt", content: "same permitted note" },
      );
      expect(written.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Successfully wrote"),
          }),
        ]),
      );
      expect(
        await fs.readFile(path.join(params.workspaceDir, "voice-parity-note.txt"), "utf8"),
      ).toBe("same permitted note");
      results.push(result.details);
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      return { payloads: [{ text: "Done." }], meta: { durationMs: 1 } };
    } finally {
      host.close();
    }
  });
  await rpc("chat.send", {
    sessionKey,
    message: "Carry out the action",
    idempotencyKey: "parity-text",
  });
  await waitForDispatchEnd();
  expect(results).toHaveLength(1);
  const retained = await retainTalkClientRunAuthority({ client, context });
  try {
    const runner = createTalkClientAgentConsultRunner({
      config: getRuntimeConfig(),
      context,
      sessionTarget: await prepareTalkSessionTarget(getRuntimeConfig(), sessionKey),
      ownerConnId: connectionId,
      runAuthority: retained,
      authority: resolveTalkAgentConsultAuthority(client.connect.scopes, client),
      getVoiceSessionId: () => voiceSessionId,
      initialItems: [],
    });
    await resetWriteMarker();
    expect(await runner.runArgs({ question: "Carry out the action" })).toEqual({ text: "Done." });
    expect(results).toHaveLength(2);
    await resetWriteMarker();
    await consult("Carry out the action", "parity-provider-call");
    await waitForDispatchEnd();
    expect(results).toHaveLength(3);
    expect(prepared[0]).toMatchObject({
      principal: expectDefined(client.authenticatedUserProfile, "authenticated caller profile")
        .profileId,
    });
    expect(prepared[1]).toEqual(prepared[0]);
    expect(prepared[2]).toEqual(prepared[0]);
    const replay = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: randomUUID(),
        method: "talk.client.toolCall",
        params: {
          sessionKey,
          voiceSessionId,
          callId: "parity-provider-call",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: "Carry out the action" },
        },
      },
      context,
      client,
      respond: replay,
      isWebchatConnect: () => true,
    });
    // Completed work cannot be advertised as a new active subscription. Keep
    // that terminal refusal, without treating a retransmit as new work.
    expect(replay.mock.calls[0]).toMatchObject([
      false,
      undefined,
      {
        code: "UNAVAILABLE",
        message: "Realtime agent consult completed before the tool result subscription started.",
      },
    ]);
    await waitForDispatchEnd();
    expect(results).toHaveLength(3);
    await resetWriteMarker();
    await consult("Carry out the action", "parity-provider-fresh-call");
    await waitForDispatchEnd();
    expect(results).toHaveLength(4);
    expect(await fs.readFile(expectDefined(marker, "native effect file"), "utf8")).toBe(
      "effect\neffect\neffect\neffect\n",
    );
  } finally {
    retained.release();
  }
}
