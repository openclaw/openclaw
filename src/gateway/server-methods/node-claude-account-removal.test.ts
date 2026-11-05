// Real loopback Gateway and paired node. The node records invoke frames that
// arrive on its websocket. No test socket and no injected success result.
import path from "node:path";
import { expect, it } from "vitest";
import { withTestRunAdmission } from "../../agents/admitted-run-context.test-support.js";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  upsertAuthProfileAsync,
} from "../../agents/auth-profiles/profiles.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import {
  CliCredentialRemovedError,
  createCliCredentialUseCheck,
} from "../../agents/cli-runner/auth-profile-preparation-error.js";
import { executeNodeClaudeRun } from "../../agents/cli-runner/execute-node-claude.js";
import type { CliExecutionHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { approveNodePairing, requestNodePairing } from "../../infra/device-pairing-node.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../../infra/node-commands.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { pairDeviceIdentity } from "../device-authz.test-helpers.js";
import { captureGatewayKernel } from "../server.capture-kernel.test-support.js";
import { connectGatewayClient } from "../test-helpers.e2e.js";
import { installGatewayTestHooks, startServerWithClient } from "../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const profileId = "anthropic:node-proof";

function trace(line: string) {
  console.log(`TRACE ${line}`);
}

type InvokeFrame = { id?: string; nodeId?: string; command?: string };

function successPayload() {
  return { exitCode: 0, stderrTail: "", truncated: false };
}

it("traces paired-node Claude dispatch and account removal on a loopback Gateway", async () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
  const kernel = await captureGatewayKernel(async () => {
    started = await startServerWithClient("trace-token");
  });
  const gateway = started!;
  const root = process.env.OPENCLAW_STATE_DIR!;
  const agentDir = path.join(root, "agents", "main", "agent");
  await upsertAuthProfileAsync({
    profileId,
    agentDir,
    credential: createApiKeyCredential("anthropic", "sk-test"),
  });
  const check = createCliCredentialUseCheck(profileId, agentDir);
  const { identity } = await pairDeviceIdentity({
    name: "claude-account-trace",
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    platform: "macos",
    deviceFamily: "mac",
  });
  const pairing = await requestNodePairing({
    nodeId: identity.deviceId,
    displayName: "Account trace node",
    platform: "macos",
    commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.admin", "operator.write"],
  });
  const requests: InvokeFrame[] = [];
  const node = await connectGatewayClient({
    url: `ws://127.0.0.1:${gateway.port}`,
    token: "trace-token",
    deviceIdentity: identity,
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: "Account trace node",
    platform: "macos",
    deviceFamily: "mac",
    mode: GATEWAY_CLIENT_MODES.NODE,
    commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
    onEvent: (event) => {
      if (event.event !== "node.invoke.request" || !event.payload) {
        return;
      }
      const frame = event.payload as InvokeFrame;
      requests.push({ command: frame.command });
      if (!frame.id || !frame.nodeId) {
        return;
      }
      void node.request("node.invoke.result", {
        id: frame.id,
        nodeId: frame.nodeId,
        ok: true,
        payloadJSON: JSON.stringify(successPayload()),
      });
    },
  });
  const run = (history?: () => Promise<void>) => {
    const context = buildPreparedCliRunContext({
      timeoutMs: 15_000,
      agentId: "main",
      sessionKey: "agent:main:account-trace",
    });
    context.executionTarget = { kind: "node", placement: { nodeId: identity.deviceId } };
    context.preparedBackend.prepareCredentialUse = check;
    if (history) {
      context.cliHistoryWriter = {
        runId: "account-trace",
        authFingerprint: "trace",
        assertCurrent: () => {},
        assertReadable: history,
        bindsNativeLogin: false,
        checkNativeLoginBoundary: () => {},
        bindExecutionEnv: () => {},
        replaysHistory: false,
        settleNativeLogin: async () => {},
      } as CliExecutionHistoryWriter;
    }
    return withTestRunAdmission(
      {
        admittedRunContext: context.params.admittedRunContext,
        runId: context.params.runId,
        agentId: "main",
      },
      (admitted) => {
        context.params.admittedRunContext = admitted;
        return withPluginRuntimeGatewayRequestScope(
          { context: kernel.gatewayRequestContext, isWebchatConnect: () => false },
          () =>
            executeNodeClaudeRun({
              context,
              nodePlacement: { nodeId: identity.deviceId },
              executionArgs: ["-p"],
              stdinPayload: "hello",
              noOutputTimeoutMs: 2_000,
              prepareCredentialUse: check,
              consumeStdout: () => {},
              consumeStderr: () => {},
            }),
        );
      },
    );
  };
  try {
    requests.length = 0;
    const retained = await run();
    expect(retained.result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe(NODE_AGENT_CLI_CLAUDE_RUN_COMMAND);
    trace("retained account: node received 1 node.invoke.request and returned exit 0");

    await check();
    await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [profileId] });
    requests.length = 0;
    await expect(run()).rejects.toBeInstanceOf(CliCredentialRemovedError);
    expect(requests).toEqual([]);
    trace("preparation: account removed after setup and before dispatch; node frames=0");

    await upsertAuthProfileAsync({
      profileId,
      agentDir,
      credential: createApiKeyCredential("anthropic", "sk-test"),
    });
    requests.length = 0;
    await expect(
      run(async () => {
        await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [profileId] });
      }),
    ).rejects.toBeInstanceOf(CliCredentialRemovedError);
    expect(requests).toEqual([]);
    trace("history authorization: account removed during the wait; node frames=0");
  } finally {
    await node.stopAndWait();
    gateway.ws.close();
    await gateway.server.close();
    gateway.envSnapshot.restore();
  }
}, 120_000);
