import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi, type Mock } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import {
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshot,
  saveExecApprovals,
} from "../infra/exec-approvals.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { coerceNodeInvokePayload } from "../node-host/invoke-payload.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayClient, GatewayClientOptions } from "./client.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  emitLifecycleAssistantReply,
  withSessionSendReceiverTools,
} from "./server.sessions-send-authority.test-support.js";
import { agentCommandMock } from "./test-helpers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

type CreateExecutionNodeClient = (
  options: Pick<GatewayClientOptions, "commands" | "deviceIdentity" | "onHelloOk" | "onEvent">,
) => Pick<GatewayClient, "start" | "stopAndWait" | "request">;

async function connectExecutionNode(createClient: CreateExecutionNodeClient) {
  const { handleInvoke } = await import("../node-host/invoke.js");
  const deviceIdentity = loadOrCreateDeviceIdentity({ identityKey: "session-send-exec-node" });
  const deviceRequest = await requestDevicePairing({
    deviceId: deviceIdentity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
    role: "node",
    clientId: "node-host",
    clientMode: "node",
    scopes: [],
  });
  await approveDevicePairing(deviceRequest.request.requestId, { callerScopes: ["operator.admin"] });
  const commands = ["system.run.prepare", "system.run", "system.execApprovals.get"];
  const request = await requestNodePairing({
    nodeId: deviceIdentity.deviceId,
    caps: ["system"],
    commands,
  });
  expect(
    await approveNodePairing(request.request.requestId, { callerScopes: ["operator.admin"] }),
  ).toMatchObject({ node: { nodeId: deviceIdentity.deviceId } });
  let connected = false;
  const invocations: string[] = [];
  const pending = new Set<Promise<void>>();
  const client = createClient({
    commands,
    deviceIdentity,
    onHelloOk: () => {
      connected = true;
    },
    onEvent: (event) => {
      if (event.event !== "node.invoke.request") {
        return;
      }
      const frame = coerceNodeInvokePayload(event.payload);
      if (!frame) {
        throw new Error("invalid execution-node invocation");
      }
      invocations.push(frame.command);
      // Real node preparation, policy checks, process spawn, and result RPC.
      const invocation = handleInvoke(frame, client, { current: async () => [] });
      pending.add(invocation);
      void invocation.finally(() => pending.delete(invocation));
    },
  });
  client.start();
  try {
    await vi.waitFor(() => expect(connected).toBe(true), { timeout: 5_000 });
  } catch (error) {
    await client.stopAndWait({ timeoutMs: 2_000 });
    throw error;
  }
  return {
    nodeId: deviceIdentity.deviceId,
    invocations,
    close: async () => {
      try {
        await Promise.all(pending);
      } finally {
        await client.stopAndWait({ timeoutMs: 2_000 });
      }
    },
  };
}

export async function runSessionsSendNodeAuthorityScenario(params: {
  nodeOnly: boolean;
  gatewayContext: GatewayRequestContext;
  createNodeClient: CreateExecutionNodeClient;
  makeTempDir: (prefix: string) => string;
}): Promise<void> {
  const dir = params.makeTempDir("openclaw-sessions-send-node-effect-");
  const sourceSessionKey = "agent:main:cron:node-proof:run:source";
  const previousConfig = getRuntimeConfig();
  const previousApprovals = readExecApprovalsSnapshot();
  const config: OpenClawConfig = {
    tools: {
      allow: ["sessions_send", "exec", "write"],
      sessions: { visibility: "all" },
      exec: { host: "auto", security: "full", ask: "off" },
    },
  };
  let node: Awaited<ReturnType<typeof connectExecutionNode>> | undefined;
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef("node-effect-source"),
    facts: {
      runId: "node-effect-source",
      agentId: "main",
      ingress: { kind: "system", boundary: "sessions-send-effect-test", state: "present" },
    },
  });
  let receiverExecAvailable: boolean | undefined;
  let receiverEffectError: unknown;
  const spy = agentCommandMock as unknown as Mock<
    (opts: AgentCommandGatewayIngressOpts) => Promise<void>
  >;
  spy.mockImplementation(async (opts) => {
    await opts.userTurnTranscriptRecorder?.persistApproved();
    if (opts.transcriptMessage !== undefined) {
      return;
    }
    try {
      await withSessionSendReceiverTools(opts, config, dir, async (tools) => {
        const exec = tools.find((tool) => tool.name === "exec");
        receiverExecAvailable = Boolean(exec);
        if (exec) {
          const result = await exec.execute("receiving-local-command", {
            command: "printf receiver-exec-proof > receiver-exec.txt",
            host: "gateway",
          });
          expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
        }
        await tools
          .find((tool) => tool.name === "write")!
          .execute("receiving-write-control", {
            path: "receiver-write.txt",
            content: "transferable tool completed\n",
          });
      });
    } catch (error) {
      receiverEffectError = error;
    } finally {
      await emitLifecycleAssistantReply(opts);
    }
  });
  try {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
    await writeConfigFile({ ...previousConfig, tools: { exec: config.tools!.exec } });
    if (params.nodeOnly) {
      node = await connectExecutionNode(params.createNodeClient);
    }
    const sourceContext = await admission.admit("embedded");
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: sourceContext,
      agentId: "main",
      sessionKey: sourceSessionKey,
    });
    await withPluginRuntimeGatewayContextResolver(
      () => params.gatewayContext,
      () =>
        withGatewayToolCallerIdentity(identity, async () => {
          const tools = params.nodeOnly
            ? resolveGatewayScopedTools({
                cfg: config,
                sessionKey: sourceSessionKey,
                surface: "loopback",
                senderIsOwner: true,
                workspaceDir: dir,
                includeNodeExecTool: true,
                nodeExecAvailable: () =>
                  params.gatewayContext.nodeRegistry
                    .listConnected()
                    .some((entry) => entry.nodeId === node?.nodeId),
                mediatedToolNames: ["write"],
              }).tools
            : createOpenClawCodingTools({
                config,
                agentId: "main",
                sessionKey: sourceSessionKey,
                senderIsOwner: true,
                cwd: dir,
                workspaceDir: dir,
              });
          const exec = tools.find((tool) => tool.name === "exec");
          expect(exec).toBeDefined();
          const executed = await exec!.execute("source-exec-control", {
            command: "printf source-exec-proof",
          });
          expect(executed.details).toMatchObject({
            status: "completed",
            exitCode: 0,
            aggregated: "source-exec-proof",
          });
          const sent = await tools
            .find((tool) => tool.name === "sessions_send")!
            .execute("node-policy-send", {
              sessionKey: "main",
              message: "execute the receiving file effects",
              timeoutSeconds: 5,
            });
          expect(sent.details).toMatchObject({ status: "ok" });
        }),
    );
    expect(receiverEffectError).toBeUndefined();
    await expect(fs.readFile(path.join(dir, "receiver-write.txt"), "utf8")).resolves.toBe(
      "transferable tool completed\n",
    );
    if (params.nodeOnly) {
      expect(node?.invocations).toEqual(
        expect.arrayContaining(["system.run.prepare", "system.run"]),
      );
      await expect(fs.stat(path.join(dir, "receiver-exec.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      await expect(fs.readFile(path.join(dir, "receiver-exec.txt"), "utf8")).resolves.toBe(
        "receiver-exec-proof",
      );
    }
    expect(receiverExecAvailable).toBe(!params.nodeOnly);
    console.info(
      `sessions_send ${params.nodeOnly ? "node-only" : "generic"} exec proof: source command completed; Gateway receiver admitted; local exec file ${params.nodeOnly ? "absent" : "written"}; transferable write file written`,
    );
  } finally {
    try {
      await waitForGatewayActiveWork();
    } finally {
      admission.close();
      try {
        await node?.close();
      } finally {
        await writeConfigFile(previousConfig).finally(() =>
          restoreExecApprovalsSnapshot(previousApprovals),
        );
      }
    }
  }
}
