import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createExecTool } from "../agents/bash-tools.js";
import { abortable } from "../agents/embedded-agent-runner/run/abortable.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readExecApprovalsSnapshot, saveExecApprovals } from "../infra/exec-approvals.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createParityAppFixture } from "./server.installed-app.test-support.js";
import {
  createGatewaySuiteHarness,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "./test-helpers.js";

// Reuses the history suite's one Gateway and real ingress/model fixture.
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
  installedApp = false,
  testSignal,
}: {
  harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
  client: GatewayClient;
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  canonicalKey: string;
  sessionId: string;
  storePath: string;
  voiceSessionId: string | undefined;
  connectionId: string;
  runEmbeddedAgent: MockInstance<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  waitForDispatchEnd: () => Promise<void>;
  installedApp?: boolean;
  testSignal?: AbortSignal;
}) {
  const scope = () => ({ agentId, sessionKey: canonicalKey, sessionId, storePath });

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
  expect(
    (
      await connectReq(reviewer, {
        deviceIdentityPath: identity.identityPath,
        scopes: ["operator.read", "operator.write", "operator.admin", "operator.approvals"],
        caps: ["exec-approvals"],
        prePairDevice: true,
      })
    ).ok,
  ).toBe(true);
  observeConnect.mockRestore();
  client.connect = expectDefined(acceptedConnect, "actual host-authenticated connect");
  const commands = [
    "system.run",
    "system.run.prepare",
    "system.which",
    "system.execApprovals.get",
    "system.execApprovals.set",
    ...(installedApp ? ["device.apps", "device.apps.launch"] : []),
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
  // RPC helpers republish persisted fixture config; retain the explicit app-command opt-in.
  if (installedApp) {
    await writeConfigFile(config);
  }
  await prepareGatewayReplyRuntimeForTest({ force: true, config });
  const token = expectDefined(
    asOptionalRecord(testState.gatewayAuth)?.token,
    "fixture gateway token",
  );
  if (typeof token !== "string") {
    throw new Error("invalid fixture auth");
  }
  let permitReceived = createDeferred();
  let permitRelease = createDeferred();
  let cancelReceived = createDeferred();
  let holdPermit = false;
  let holdCancellation = false;
  const node = await createTalkParityNodeFixture(
    config,
    harness.port,
    token,
    installedApp,
    installedApp
      ? {
          beforePermit: async () => {
            permitReceived.resolve();
            if (holdPermit) {
              await permitRelease.promise;
            }
          },
          holdCancellation: () => holdCancellation,
          onCancellation: () => cancelReceived.resolve(),
        }
      : undefined,
  );
  const provider = await installTalkParityProviderFixture();
  const originalConnections = context.getClientConnIds;
  context.getClientConnIds = (filter) => new Set(!filter || filter(client) ? [connectionId] : []);
  const { closeTalkClientGatewayControlSession } = await import("./talk/client-gateway-control.js");
  const workspace = expectDefined(config.agents?.defaults?.workspace, "fixture workspace");
  const marker = path.join(workspace, "node-parity-effects");
  const processExec = await import("../process/exec.js");
  const originalRun = processExec.runCommandWithTimeout;
  const native: Array<{
    argv: string[];
    cwd?: string;
    result: import("../process/exec-result.js").SpawnResult;
  }> = [];
  const observeNative = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockImplementation(async (...args) => {
      const result = await originalRun(...args);
      if (args[0].some((arg) => arg.includes(marker))) {
        native.push({
          argv: [...args[0]],
          cwd: typeof args[1] === "object" ? args[1].cwd : undefined,
          result,
        });
      }
      return result;
    });
  const appFixture = await createParityAppFixture(workspace, installedApp);
  const { children: appChildren, cleanup: cleanupAppChildren } = appFixture;
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
    installedApp
      ? Promise.resolve(
          appChildren.some((child) => child.exitCode === null && child.signalCode === null)
            ? "effect"
            : "",
        )
      : fs
          .stat(marker)
          .then(() => "effect")
          .catch((error: unknown) => {
            if (asOptionalRecord(error)?.code === "ENOENT") {
              return "";
            }
            throw error;
          });
  const previousApprovals = installedApp ? readExecApprovalsSnapshot().file : undefined;
  const observed: unknown[] = [];
  const outcomes: unknown[] = [];
  try {
    for (const ingress of ["text", "direct", "chat-backed"] as const) {
      for (const decision of [
        ...(installedApp
          ? (["allow-once", "permitted", "policy-deny"] as const)
          : (["permitted", "policy-deny", "allow-once"] as const)),
        "deny",
        "cancel",
        "source-revoke",
        ...(installedApp
          ? ([
              "node-ask",
              "node-deny",
              "cancel-delivered-after-permit",
              "cancel-inflight-after-permit",
            ] as const)
          : []),
      ] as const) {
        const key = ingress + "-" + decision;
        const postPermitCancel =
          decision === "cancel-delivered-after-permit" ||
          decision === "cancel-inflight-after-permit";
        holdPermit = postPermitCancel;
        holdCancellation = decision === "cancel-inflight-after-permit";
        permitReceived = createDeferred();
        permitRelease = createDeferred();
        cancelReceived = createDeferred();
        const cancellationStart = { ...node.cancellations };
        const permitsEffect =
          decision === "permitted" || decision === "allow-once" || decision === "node-ask";
        const requiresApproval =
          decision !== "permitted" &&
          decision !== "policy-deny" &&
          decision !== "node-deny" &&
          !postPermitCancel;
        if (installedApp) {
          saveExecApprovals({
            version: 1,
            defaults: { security: "full", ask: "off" },
            agents: {
              [agentId]: {
                security: decision === "node-deny" ? "deny" : "full",
                ask: decision === "node-ask" ? "always" : "off",
              },
            },
          });
        }
        const invocationCount = node.invokes.length;
        const nativeCount = native.length;
        const appCount = appChildren.length;
        await fs.rm(marker, { force: true });
        await replaceSessionEntry(scope(), {
          sessionId,
          updatedAt: Date.now(),
          execHost: "node",
          execNode: node.nodeId,
          execCwd: workspace,
          permissionMode:
            decision === "permitted" ||
            decision === "node-ask" ||
            decision === "node-deny" ||
            postPermitCancel
              ? "full"
              : decision === "policy-deny"
                ? "read-only"
                : "guarded",
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
        runEmbeddedAgent.mockImplementationOnce(async (params) => {
          const admission = expectDefined(params.preparedRunAdmission, "real ingress admission");
          const admittedRunContext = await admission.admit(
            "plugin-harness",
            "node-parity-fixed-model",
          );
          const host = createAgentHarnessHostCapabilities({
            pluginId: "node-parity-fixed-model",
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
            base: config.tools.exec,
            overrides: params.execOverrides,
            permissionPolicy: { mode: params.permissionMode ?? "read-only" },
          });
          observed.push({
            ingress,
            decision,
            principal: expectDefined(
              admission.readOperatorAuthority?.()?.profileId,
              "authenticated operator source",
            ),
            reviewer: params.approvalReviewerDeviceId,
            host: policy.host,
            node: params.execOverrides?.node,
            cwd: params.execOverrides?.nodeCwd,
          });
          const [tool, nodes] = host.capabilities.bindToolSurface([
            createExecTool({
              ...policy,
              config: params.config,
              cwd: params.workspaceDir,
              node: params.execOverrides?.node,
              nodeCwd: params.execOverrides?.nodeCwd,
              agentId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              runId: params.runId,
              approvalReviewerDeviceId: params.approvalReviewerDeviceId,
              allowBackground: false,
              notifyOnExit: false,
            }),
            createNodesTool({
              agentId,
              agentSessionKey: params.sessionKey,
              config: params.config,
              execSession: {
                permissionMode: params.permissionMode,
                execCwd: params.execOverrides?.nodeCwd,
              },
              sessionId: params.sessionId,
              agentChannel: params.messageProvider,
              execOverrides: params.execOverrides,
              approvalReviewerDeviceIds: params.approvalReviewerDeviceId
                ? [params.approvalReviewerDeviceId]
                : [],
            }),
          ]);
          started.resolve(params.runId);
          try {
            const lookup = await expectDefined(nodes, "bound nodes tool").execute(
              "same-lookup",
              { action: "which", node: node.nodeId, bins: ["sh"] },
              params.abortSignal,
            );
            expect(JSON.stringify(lookup)).toContain("/sh");
            let result;
            if (installedApp) {
              const apps = await expectDefined(nodes, "bound Nodes inventory").execute(
                "inventory",
                {
                  action: "app_list",
                  node: node.nodeId,
                  query: "Parity app",
                },
                params.abortSignal,
              );
              const inventory = asOptionalRecord(asOptionalRecord(apps.details)?.payload);
              const app = Array.isArray(inventory?.apps)
                ? asOptionalRecord(inventory.apps[0])
                : undefined;
              expect(app).toMatchObject({ appId: "linux-desktop:parity.desktop" });
              result = await expectDefined(nodes, "bound Nodes launch").execute(
                "same-native-action",
                {
                  action: "app_launch",
                  node: node.nodeId,
                  appId: app?.appId,
                  appRevision: app?.appRevision,
                },
                params.abortSignal,
              );
            } else {
              result = await expectDefined(tool, "bound native exec").execute(
                "same-native-action",
                {
                  command: "/usr/bin/touch " + JSON.stringify(marker),
                  workdir: workspace,
                  yieldMs: 10000,
                },
                params.abortSignal,
              );
            }
            finished.resolve(result.details);
            return { payloads: [{ text: "Native action finished." }], meta: { durationMs: 0 } };
          } catch (error) {
            finished.resolve({ error: String(error) });
            return { payloads: [{ text: "Native action did not run." }], meta: { durationMs: 0 } };
          } finally {
            host.close();
          }
        });
        try {
          if (ingress === "direct") {
            const respond = vi.fn<RespondFn>();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: key + "-create",
                method: "talk.client.create",
                params: {
                  sessionKey,
                  provider: "openai",
                  mode: "realtime",
                  brain: "agent-consult",
                  transport: "webrtc",
                  capabilities: ["voice-transcript"],
                },
              },
              context,
              client,
              respond,
              isWebchatConnect: () => true,
              hasCurrentClientAuthority: source.isCurrent,
            });
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
            const respond = vi.fn<RespondFn>();
            task = handleGatewayRequest({
              req: { type: "req", id: key, method, params },
              context,
              client,
              respond,
              isWebchatConnect: () => true,
              hasCurrentClientAuthority: source.isCurrent,
            });
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
              invalidateGatewayDeviceRevocation(context, identity.identity.deviceId, "operator");
            } else {
              expect(
                (
                  await rpcReq(reviewer, "exec.approval.resolve", {
                    id: approvalId,
                    decision: decision === "node-ask" ? "allow-once" : decision,
                  })
                ).ok,
              ).toBe(true);
              await rpcReq(reviewer, "exec.approval.resolve", {
                id: approvalId,
                decision: decision === "node-ask" ? "allow-once" : decision,
              });
            }
          }
          if (postPermitCancel) {
            await Promise.race([
              permitReceived.promise,
              finished.promise.then((outcome) => {
                throw new Error("No native permit: " + JSON.stringify(outcome));
              }),
            ]);
            expect(await effectText()).toBe(before);
            console.info(
              "App handoff observed:",
              JSON.stringify({
                scenario: key,
                permitIssued: true,
                nativeEffects: appChildren.length - appCount,
              }),
            );
            await rpc("chat.abort", { sessionKey, runId });
            if (testSignal) {
              await abortable(testSignal, cancelReceived.promise);
            } else {
              await cancelReceived.promise;
            }
            permitRelease.resolve();
            await node.drain();
          }
          const result = await finished.promise;
          if (
            ingress === "direct" &&
            (decision === "cancel" || decision === "source-revoke" || postPermitCancel)
          ) {
            await expect(task).rejects.toMatchObject({ name: "AbortError" });
          } else {
            await task;
          }
          await waitForDispatchEnd();
          if (permitsEffect) {
            if (installedApp) {
              expect(appChildren.slice(appCount), key + ": " + JSON.stringify(result)).toHaveLength(
                1,
              );
              const child = expectDefined(appChildren.at(-1), "actual app child");
              expect(result).toMatchObject({ status: "process-started", pid: child.pid });
              expect(child.pid).toBeGreaterThan(0);
              expect(() =>
                process.kill(expectDefined(child.pid, "actual app PID"), 0),
              ).not.toThrow();
            } else {
              expect(result, key + ": " + JSON.stringify(result)).toMatchObject({
                status: "completed",
                exitCode: 0,
                nodeId: node.nodeId,
              });
            }
            expect(await effectText()).toBe(before + "effect");
          } else if (decision === "cancel-inflight-after-permit") {
            const children = appChildren.slice(appCount);
            expect(children).toHaveLength(1);
            expect(asOptionalRecord(result)?.status).not.toBe("process-started");
            expect(() =>
              process.kill(expectDefined(children[0]?.pid, "in-flight cancellation native PID"), 0),
            ).not.toThrow();
            expect(await effectText()).toBe("effect");
          } else {
            expect(await effectText()).toBe(before);
          }
          if (postPermitCancel) {
            expect(node.cancellations.received - cancellationStart.received).toBe(1);
            expect(node.cancellations.delivered - cancellationStart.delivered).toBe(
              holdCancellation ? 0 : 1,
            );
          }
          expect(approvalEvents - eventCount).toBe(requiresApproval ? 1 : 0);
          const cellInvocations = node.invokes.slice(invocationCount);
          const cellNative = native.slice(nativeCount);
          expect(cellInvocations.filter((frame) => frame.command === "system.which")).toHaveLength(
            1,
          );
          if (decision === "policy-deny") {
            // A policy refusal is not an operator rejection (or a failed lookup).
            // The real exec owner refuses before any node execution preparation.
            if (installedApp) {
              expect(asOptionalRecord(result)?.error).toContain(
                "exec denied: host=node security=deny",
              );
            } else {
              expect(result).toEqual({ error: "Error: exec denied: host=node security=deny" });
            }
            expect(
              cellInvocations.filter((frame) => frame.command.startsWith("system.run")),
            ).toEqual([]);
            expect(cellNative).toEqual([]);
            expect(appChildren.slice(appCount)).toEqual([]);
          }
          outcomes.push({
            scenario: key,
            approvals: approvalEvents - eventCount,
            execDispatches: cellInvocations.filter((frame) => frame.command === "system.run")
              .length,
            nodesWhich: cellInvocations.filter((frame) => frame.command === "system.which").length,
            markerPresent: (await effectText()) !== "",
            canonicalExecDenial:
              asOptionalRecord(result)?.error === "Error: exec denied: host=node security=deny",
            cancellationReceived: node.cancellations.received - cancellationStart.received,
            cancellationDelivered: node.cancellations.delivered - cancellationStart.delivered,
            appDispatches: cellInvocations.filter((frame) => frame.command === "device.apps.launch")
              .length,
            nativeApps: appChildren.slice(appCount).map((child) => ({
              pid: child.pid,
              aliveAtReply: child.exitCode === null && child.signalCode === null,
            })),
            native: cellNative.map(({ result: completion }) => ({
              pid: completion.pid,
              code: completion.code,
              termination: completion.termination,
            })),
          });
          if (installedApp) {
            console.info("App permission cell observed:", JSON.stringify(outcomes.at(-1)));
          }
        } finally {
          permitRelease.resolve();
          node.releaseCancellation();
          invalidateGatewayDeviceRevocation(context, identity.identity.deviceId, "operator");
          await task?.catch(() => {});
          await waitForDispatchEnd();
          if (directVoiceSessionId) {
            await closeTalkClientGatewayControlSession({
              voiceSessionId: directVoiceSessionId,
              sessionKey,
              connId: connectionId,
            });
          }
          await cleanupAppChildren();
          source.release();
        }
      }
    }
    if (!installedApp) {
      expect(native).toHaveLength(6);
      for (const invocation of native) {
        expect(invocation.argv).toEqual(native[0]?.argv);
        expect(invocation.argv.join(" ")).toContain(marker);
        expect(invocation.cwd).toBe(workspace);
        expect(invocation.result.pid).toBeGreaterThan(0);
        expect(invocation.result).toMatchObject({ code: 0, termination: "exit" });
      }
    } else {
      expect(appChildren).toHaveLength(12);
    }
    for (const row of observed) {
      expect(row).toMatchObject({
        principal: expectDefined(
          client.authenticatedUserProfile?.profileId,
          "fixture's authenticated profile",
        ),
        reviewer: identity.identity.deviceId,
        host: "node",
        node: node.nodeId,
        cwd: workspace,
      });
    }
    expect(
      node.invokes.filter(
        (frame) => frame.command === (installedApp ? "device.apps.launch" : "system.run"),
      ),
    ).toHaveLength(installedApp ? 15 : 6);
    expect(node.invokes.filter((frame) => frame.command === "system.which")).toHaveLength(
      installedApp ? 30 : 18,
    );
    expect(outcomes).toHaveLength(installedApp ? 30 : 18);
    // Observed, public-safe values only: no identities, transcripts, paths or credentials.
    if (!installedApp) {
      console.info("Talk permission parity observed:", JSON.stringify(outcomes));
    }
  } finally {
    permitRelease.resolve();
    node.releaseCancellation();
    context.getClientConnIds = originalConnections;
    provider.restore();
    observeNative.mockRestore();
    await node.close();
    await cleanupAppChildren();
    appFixture.restore();
    reviewer.off("message", onMessage);
    reviewer.close();
    if (installedApp) {
      if (previousApprovals) {
        saveExecApprovals(previousApprovals);
      }
      await writeConfigFile(current);
    }
  }
}
