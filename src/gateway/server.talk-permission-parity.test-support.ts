import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createExecTool } from "../agents/bash-tools.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import { getRuntimeConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { listRpcSourceEntries } from "../sessions/session-controller.rpc-sources.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { captureRpcSourceScopeMatcher } from "./session-runtime-scope.js";
import { talkClientHandlers } from "./talk/handlers/client.js";
import {
  createGatewaySuiteHarness,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "./test-helpers.js";

type TalkParityFixture = {
  context: GatewayRequestContext;
  client: GatewayClient;
  sessionKey: string;
  voiceSessionId: string | undefined;
  runEmbeddedAgent: MockInstance<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;
  waitForDispatchEnd: () => Promise<void>;
};

function visibleResult(text: string, durationMs = 0) {
  return {
    payloads: [{ text }],
    meta: { durationMs, terminalReply: { disposition: "visible" as const, text } },
  };
}

export async function runTalkNodePermissionParity({
  harness,
  client,
  context,
  agentId,
  sessionKey,
  canonicalKey,
  sessionId,
  storePath,
  voiceSessionId,
  connectionId,
  runEmbeddedAgent,
  rpc,
  waitForDispatchEnd,
  expectRevokedWriter,
  publicOnly = false,
}: TalkParityFixture & {
  publicOnly?: boolean;
  harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
  agentId: string;
  canonicalKey: string;
  sessionId: string;
  storePath: string;
  connectionId: string;
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  expectRevokedWriter: (runId: string, isCurrent: () => boolean) => void;
}) {
  const scope = { agentId, sessionKey: canonicalKey, sessionId, storePath };
  const matchesSourceScope = captureRpcSourceScopeMatcher({
    storePath,
    resolveGatewayContext: context.resolveGatewayContext,
  });

  const { createTalkParityNodeFixture, installTalkParityProviderFixture } =
    await import("./server.talk-node-parity.test-support.js");
  const { connectReq, rpcReq } = await import("./test-helpers.js");
  const { loadDeviceIdentity } = await import("./device-authz.test-helpers.js");
  const { createNodesTool } = await import("../agents/tools/nodes-tool.js");
  const { captureGatewayDeviceRevocation, invalidateGatewayDeviceRevocation } =
    await import("./device-revocation.js");
  const { validateConnectParams } = await import("../../packages/gateway-protocol/src/index.js");
  // Minimal Gateway suites omit normal process-identity bootstrap. Approved node
  // dispatch must reuse a real persisted identity, never manufacture one after approval.
  const { loadOrCreateDeviceIdentityAsync } = await import("../infra/device-identity-async.js");
  await loadOrCreateDeviceIdentityAsync();
  const identity = loadDeviceIdentity("talk-parity-reviewer");
  const reviewer = await harness.openWs();
  const send = reviewer.send.bind(reviewer);
  let acceptedConnect: GatewayClient["connect"] | undefined;
  const observeConnect = vi.spyOn(reviewer, "send").mockImplementation((...args) => {
    const frame = JSON.parse(
      typeof args[0] === "string"
        ? args[0]
        : Buffer.isBuffer(args[0])
          ? args[0].toString("utf8")
          : "null",
    );
    if (frame?.method === "connect" && validateConnectParams(frame.params)) {
      acceptedConnect = frame.params;
    }
    return send(...args);
  });
  await expect(
    connectReq(reviewer, {
      deviceIdentityPath: identity.identityPath,
      scopes: ["operator.read", "operator.write", "operator.admin", "operator.approvals"],
      caps: ["exec-approvals"],
      prePairDevice: true,
    }),
  ).resolves.toMatchObject({ ok: true });
  observeConnect.mockRestore();
  client.connect = expectDefined(acceptedConnect, "actual host-authenticated connect");
  const commands = [
    "system.run",
    "system.run.prepare",
    "system.which",
    "system.execApprovals.get",
    "system.execApprovals.set",
  ];
  const current = getRuntimeConfig();
  const config = {
    ...current,
    gateway: {
      ...current.gateway,
      port: harness.port,
      nodes: {
        ...current.gateway?.nodes,
        commands: { allow: commands },
      },
    },
    tools: { ...current.tools, exec: { host: "node" as const, mode: "full" as const } },
  };
  await prepareGatewayReplyRuntimeForTest({ force: true, config });
  const token = expectDefined(
    asOptionalRecord(testState.gatewayAuth)?.token,
    "fixture gateway token",
  );
  if (typeof token !== "string") {
    throw new Error("invalid fixture auth");
  }
  const node = await createTalkParityNodeFixture(config, harness.port, token);
  const provider = await installTalkParityProviderFixture(publicOnly);
  const originalConnections = context.getClientConnIds;
  context.getClientConnIds = (filter) => new Set(!filter || filter(client) ? [connectionId] : []);
  const { closeTalkClientGatewayControlSession } = await import("./talk/client-gateway-control.js");
  const workspace = expectDefined(config.agents?.defaults?.workspace, "fixture workspace");
  const marker = path.join(workspace, "node-parity-effects");
  const processExec = await import("../process/exec.js");
  const observeNative = vi.spyOn(processExec, "runCommandWithTimeout");
  const nativeExecutions = () =>
    observeNative.mock.calls.flatMap(([argv, options], index) => {
      const result = observeNative.mock.settledResults[index];
      return argv.some((arg) => arg.includes(marker)) && result?.type === "fulfilled"
        ? [
            {
              argv,
              cwd: typeof options === "object" ? options.cwd : undefined,
              result: result.value,
            },
          ]
        : [];
    });
  let requested = createDeferred<Record<string, unknown>>();
  let approvalEvents = 0;
  const onMessage = (raw: unknown) => {
    const event = JSON.parse(String(raw));
    if (event.event === "exec.approval.requested") {
      approvalEvents++;
      requested.resolve(event.payload);
    }
  };
  reviewer.on("message", onMessage);
  const effectText = () =>
    fs
      .stat(marker)
      .then(() => "effect")
      .catch((error: unknown) => {
        if (asOptionalRecord(error)?.code === "ENOENT") {
          return "";
        }
        throw error;
      });
  const observed: unknown[] = [];
  const scenarios = publicOnly
    ? ([{ ingress: "direct", decision: "source-revoke" }] as const)
    : (["text", "direct", "chat-backed"] as const).flatMap((ingress) =>
        (
          ["permitted", "policy-deny", "allow-once", "deny", "cancel", "source-revoke"] as const
        ).map((decision) => ({ ingress, decision })),
      );
  try {
    for (const { ingress, decision } of scenarios) {
      const key = ingress + "-" + decision;
      const requiresApproval = decision !== "permitted" && decision !== "policy-deny";
      const invocationCount = node.invokes.length;
      const nativeCount = nativeExecutions().length;
      await fs.rm(marker, { force: true });
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: Date.now(),
        execHost: "node",
        execNode: node.nodeId,
        execCwd: workspace,
        permissionMode:
          decision === "permitted" ? "full" : decision === "policy-deny" ? "read-only" : "guarded",
      });
      const source = captureGatewayDeviceRevocation(
        context,
        { deviceId: identity.identity.deviceId, role: "operator" },
        () => true,
      );
      const before = await effectText();
      const eventCount = approvalEvents;
      const started = createDeferred<string>();
      const finished = createDeferred<unknown>();
      requested = createDeferred<Record<string, unknown>>();
      let task: Promise<unknown> | undefined;
      let directVoiceSessionId: string | undefined;
      let activeSignal: AbortSignal | undefined;
      let activeRunId: string | undefined;
      const dispatch = (
        method: string,
        params: Record<string, unknown>,
        id = key,
        respond = vi.fn<RespondFn>(),
      ) =>
        handleGatewayRequest({
          req: { type: "req", id, method, params },
          context,
          client,
          respond,
          isWebchatConnect: () => true,
          hasCurrentClientAuthority: source.isCurrent,
        });
      runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const admission = expectDefined(params.preparedRunAdmission, "real ingress admission");
        const admittedRunContext = await admission.admit(
          "plugin-harness",
          "node-parity-fixed-model",
        );
        const runIdentity = {
          agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          config: params.config,
        };
        const host = createAgentHarnessHostCapabilities({
          pluginId: "node-parity-fixed-model",
          attempt: {
            ...runIdentity,
            workspaceDir: params.workspaceDir,
            cwd: params.cwd,
            admittedRunContext,
          },
        });
        const policy = projectEffectiveExecPolicy({
          base: config.tools.exec,
          overrides: params.execOverrides,
          permissionPolicy: { mode: params.permissionMode ?? "read-only" },
        });
        observed.push({
          principal: admission.readOperatorAuthority?.()?.profileId,
          reviewer: params.approvalReviewerDeviceId,
          host: policy.host,
          node: params.execOverrides?.node,
          cwd: params.execOverrides?.nodeCwd,
        });
        const [tool, nodes] = host.capabilities.bindToolSurface([
          createExecTool({
            ...policy,
            ...runIdentity,
            cwd: params.workspaceDir,
            node: params.execOverrides?.node,
            nodeCwd: params.execOverrides?.nodeCwd,
            approvalReviewerDeviceId: params.approvalReviewerDeviceId,
            allowBackground: false,
            notifyOnExit: false,
          }),
          createNodesTool({ agentId, agentSessionKey: params.sessionKey, config: params.config }),
        ]);
        activeSignal = params.abortSignal;
        activeRunId = params.runId;
        started.resolve(params.runId);
        try {
          const lookup = await expectDefined(nodes, "bound nodes tool").execute(
            "same-lookup",
            { action: "which", node: node.nodeId, bins: ["sh"] },
            params.abortSignal,
          );
          expect(JSON.stringify(lookup)).toContain("/sh");
          const result = await expectDefined(tool, "bound native exec").execute(
            "same-native-action",
            {
              command: "/usr/bin/touch " + JSON.stringify(marker),
              workdir: workspace,
              yieldMs: 10000,
            },
            params.abortSignal,
          );
          finished.resolve(result.details);
          return visibleResult("Native action finished.");
        } catch (error) {
          finished.resolve({ error: String(error) });
          return visibleResult("Native action did not run.");
        } finally {
          host.close();
        }
      });
      try {
        if (ingress === "direct") {
          const respond = vi.fn<RespondFn>();
          await dispatch(
            "talk.client.create",
            {
              sessionKey,
              provider: "openai",
              mode: "realtime",
              brain: "agent-consult",
              transport: "webrtc",
              capabilities: ["voice-transcript"],
            },
            key + "-create",
            respond,
          );
          const reply = expectDefined(
            respond.mock.calls.at(-1),
            "registered direct create response",
          );
          expect({ ok: reply[0], error: reply[2] }).toEqual({ ok: true, error: undefined });
          const id = asOptionalRecord(reply[1])?.voiceSessionId;
          if (typeof id !== "string") {
            throw new Error("Missing registered voice identity");
          }
          directVoiceSessionId = id;
          task = provider.run("Carry out the action.");
        } else {
          const method = ingress === "text" ? "chat.send" : "talk.client.toolCall";
          const params =
            ingress === "text"
              ? { sessionKey, message: "Carry out the action.", idempotencyKey: key }
              : {
                  sessionKey,
                  voiceSessionId,
                  callId: key,
                  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
                  args: { question: "Carry out the action." },
                };
          task = dispatch(method, params);
        }
        void task.catch((error: unknown) => finished.resolve({ error: String(error) }));
        const runId = await started.promise;
        if (requiresApproval) {
          const pending = await Promise.race([
            requested.promise,
            finished.promise.then((outcome) => {
              throw new Error("No ordinary approval: " + JSON.stringify(outcome));
            }),
          ]);
          expect(await effectText()).toBe(before);
          const approvalId = expectDefined(pending.id, "host approval ID");
          if (decision === "cancel") {
            await rpc("chat.abort", { sessionKey, runId });
          } else if (decision === "source-revoke") {
            // The real pre-commit guard may reject an already prepared lifecycle write.
            // Accept only that exact refusal while this deliberately revoked source is stale.
            expectRevokedWriter(runId, source.isCurrent);
            invalidateGatewayDeviceRevocation(context, identity.identity.deviceId, "operator");
            if (publicOnly) {
              expect(activeSignal?.aborted, "public callback retains source cancellation").toBe(
                true,
              );
            }
          } else {
            expect(
              (await rpcReq(reviewer, "exec.approval.resolve", { id: approvalId, decision })).ok,
            ).toBe(true);
            await rpcReq(reviewer, "exec.approval.resolve", { id: approvalId, decision });
          }
        }
        const result = await finished.promise;
        if (ingress === "direct" && (decision === "cancel" || decision === "source-revoke")) {
          await expect(task).rejects.toMatchObject({ name: "AbortError" });
        } else {
          await task;
        }
        await waitForDispatchEnd();
        if (publicOnly) {
          expect(
            listRpcSourceEntries().some(
              ([candidateRunId, rpcSource]) =>
                candidateRunId === runId && matchesSourceScope(rpcSource),
            ),
          ).toBe(false);
          await expect(provider.run("Start new work after revocation")).rejects.toThrow(
            /authority|active|closed|stopped/i,
          );
        }
        if (decision === "permitted" || decision === "allow-once") {
          expect(result, key + ": " + JSON.stringify(result)).toMatchObject({
            status: "completed",
            exitCode: 0,
            nodeId: node.nodeId,
          });
          expect(await effectText()).toBe(before + "effect");
        } else {
          expect(await effectText()).toBe(before);
        }
        expect(approvalEvents - eventCount).toBe(requiresApproval ? 1 : 0);
        const cellInvocations = node.invokes.slice(invocationCount);
        const cellNative = nativeExecutions().slice(nativeCount);
        expect(cellInvocations.filter((frame) => frame.command === "system.which")).toHaveLength(1);
        if (decision === "policy-deny") {
          expect(result).toEqual({ error: "Error: exec denied: host=node security=deny" });
          expect(cellInvocations.filter((frame) => frame.command.startsWith("system.run"))).toEqual(
            [],
          );
          expect(cellNative).toEqual([]);
        }
      } finally {
        invalidateGatewayDeviceRevocation(context, identity.identity.deviceId, "operator");
        // Cleanup after a failed assertion must not mask the original revocation result.
        if (publicOnly && activeRunId && activeSignal?.aborted === false) {
          await rpc("chat.abort", { sessionKey, runId: activeRunId });
        }
        await task?.catch(() => {});
        await waitForDispatchEnd();
        if (directVoiceSessionId) {
          await closeTalkClientGatewayControlSession({
            voiceSessionId: directVoiceSessionId,
            sessionKey,
            connId: connectionId,
          });
        }
        source.release();
      }
    }
    const native = nativeExecutions();
    expect(native).toHaveLength(publicOnly ? 0 : 6);
    for (const invocation of native) {
      expect(invocation).toMatchObject({
        argv: native[0]?.argv,
        cwd: workspace,
        result: { code: 0, termination: "exit" },
      });
      expect(invocation.argv.join(" ")).toContain(marker);
      expect(invocation.result.pid).toBeGreaterThan(0);
    }
    expect(observed).toEqual(
      Array.from({ length: scenarios.length }, () => ({
        principal: client.authenticatedUserProfile?.profileId,
        reviewer: identity.identity.deviceId,
        host: "node",
        node: node.nodeId,
        cwd: workspace,
      })),
    );
    const countInvokes = (command: string) =>
      node.invokes.filter((frame) => frame.command === command).length;
    expect(countInvokes("system.run")).toBe(publicOnly ? 0 : 6);
  } finally {
    context.getClientConnIds = originalConnections;
    provider.restore();
    observeNative.mockRestore();
    reviewer.off("message", onMessage);
    await node.close();
    reviewer.close();
  }
}

export async function runTalkOperatorSourceParity({
  context,
  client,
  sessionKey,
  voiceSessionId,
  runEmbeddedAgent,
  waitForDispatchEnd,
}: TalkParityFixture) {
  let originalSource: object | undefined;
  let admittedSource: object | undefined;
  runEmbeddedAgent.mockImplementationOnce(async (params) => {
    admittedSource = params.preparedRunAdmission?.readOperatorAuthority?.()?.source;
    return visibleResult("Done.", 1);
  });
  const handler = expectDefined(talkClientHandlers["talk.client.toolCall"], "Talk RPC handler");
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: randomUUID(),
      method: "talk.client.toolCall",
      params: {
        sessionKey,
        voiceSessionId,
        callId: "source-identity-call",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "Check the requested status" },
      },
    },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
    extraHandlers: {
      "talk.client.toolCall": async (options) => {
        const original = await captureGatewayOperatorRunAuthority({
          client: options.client ?? null,
          context: options.context,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
        });
        originalSource = original?.authority.source;
        try {
          await handler(options);
        } finally {
          original?.release();
        }
      },
    },
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  await waitForDispatchEnd();
  expect(originalSource).toBeDefined();
  expect(admittedSource).toBe(originalSource);
}
