// A Gateway chat turn places Claude on a paired node. The node runs the product
// Claude invoke handler. The saved account is removed while that approval is pending.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../infra/node-commands.js";
import { createNodeInvokeResponder, type NodeHostClient } from "../node-host/client.js";
import { handleClaudeCliNodeInvoke } from "../node-host/invoke-agent-cli-claude-handler.js";
import type { NodeInvokeRequestPayload } from "../node-host/invoke-types.js";
import { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "./method-scopes.js";
import {
  createClaudeCliGatewayConfig,
  createClaudeCliGatewayEnv,
} from "./server.chat-cli-auth.test-support.js";
import { connectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const profileId = "anthropic:pasted";
const savedCredential = {
  type: "token",
  provider: "anthropic",
  token: "synthetic-pasted-anthropic-token",
} satisfies AuthProfileCredential;

function trace(line: string) {
  console.log(`TRACE ${line}`);
}

function claudeScript() {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.226\\n");
  process.exit(0);
}
if (process.argv.includes("auth")) {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  type: "result",
  result: "Node account reply.",
  session_id: "node-account-turn",
}) + "\\n");
process.exit(0);
`;
}

async function pairNodeIdentity(name: string) {
  const root = process.env.OPENCLAW_STATE_DIR ?? os.tmpdir();
  const identityPath = path.join(
    root,
    "test-device-identities",
    name,
    "client",
    "credentials.sqlite",
  );
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const request = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    platform: process.platform,
  });
  await approveDevicePairing(request.request.requestId, { callerScopes: [] });
  return identity;
}

it(
  "traces a Gateway chat turn on a paired node when the saved account is removed",
  { timeout: 180_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "node-account-turn",
      env: createClaudeCliGatewayEnv(),
    });
    const workspaceDir = state.workspaceDir;
    await fs.mkdir(workspaceDir, { recursive: true });
    const binDir = state.path("bin");
    const scriptPath = path.join(binDir, "claude.cjs");
    const executable = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    await fs.mkdir(binDir);
    const script = claudeScript();
    if (process.platform === "win32") {
      await createWindowsCmdShimFixture({
        shimPath: executable,
        scriptPath,
        shimLine: `"${process.execPath}" "%~dp0\\claude.cjs" %*`,
      });
    } else {
      await fs.writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o755 });
    }
    await fs.writeFile(scriptPath, script);
    setTestEnvValue("PATH", binDir);
    await state.writeAuthProfiles({
      version: 1,
      profiles: { [profileId]: savedCredential },
    });
    const modelRef = "anthropic/claude-sonnet-4-6";
    const token = "node-account-turn";
    const cfg = {
      ...createClaudeCliGatewayConfig(workspaceDir, modelRef, token),
      tools: {
        profile: "minimal" as const,
        exec: { security: "allowlist" as const, ask: "always" as const },
      },
    };
    const gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: [ADMIN_SCOPE, APPROVALS_SCOPE, "operator.write", "operator.read"],
    });
    await gateway.server.startupSettled;
    const identity = await pairNodeIdentity("node-account-turn");
    const pairing = await requestNodePairing({
      nodeId: identity.deviceId,
      displayName: "Account turn node",
      platform: process.platform,
      commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
    });
    await approveNodePairing(pairing.request.requestId, {
      callerScopes: [ADMIN_SCOPE, "operator.write"],
    });
    const frames: string[] = [];
    let nodeFault: unknown;
    const node = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token,
      deviceIdentity: identity,
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "Account turn node",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.NODE,
      commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload) {
          return;
        }
        const frame = event.payload as NodeInvokeRequestPayload;
        frames.push(frame.command);
        const hostClient: NodeHostClient = {
          request: (method, params, opts) => node.request(method, params, opts),
        };
        void handleClaudeCliNodeInvoke({
          frame,
          client: hostClient,
          response: createNodeInvokeResponder(hostClient, frame),
          skillBins: { current: async () => [] },
          runtime: { claudePath: executable },
        }).catch((error: unknown) => {
          nodeFault = error;
        });
      },
    });
    let approvalMode: "allow" | "remove" = "allow";
    let approvalFault: unknown;
    const approvalIds: string[] = [];
    const approver = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token,
      role: "operator",
      scopes: [ADMIN_SCOPE, APPROVALS_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "Account turn approver",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onEvent: (event) => {
        if (event.event !== "exec.approval.requested" || !event.payload) {
          return;
        }
        const id = (event.payload as { id?: string }).id;
        if (!id) {
          return;
        }
        approvalIds.push(id);
        const remove =
          approvalMode === "remove"
            ? removeAuthProfilesAcrossOwnerStores({
                agentDir: state.agentDir(),
                profileIds: [profileId],
              })
            : Promise.resolve(0);
        void remove
          .then(() => approver.request("exec.approval.resolve", { id, decision: "allow-once" }))
          .catch((error: unknown) => {
            approvalFault = error;
          });
      },
    });
    const send = async (label: string) => {
      const requestedKey = `agent:main:${label}-${randomUUID()}`;
      const created = await gateway.client.request<{ key: string }>("sessions.create", {
        agentId: "main",
        key: requestedKey,
        model: `${modelRef}@${profileId}`,
        agentRuntime: "claude-cli",
      });
      const sessionKey = created.key;
      await gateway.client.request("sessions.patch", {
        key: sessionKey,
        execHost: "node",
        execNode: identity.deviceId,
      });
      const started = frames.length;
      const accepted = await gateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey,
          message: "Reply from the paired node.",
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      );
      const completed = await gateway.client.request<{ status: string; error?: string }>(
        "agent.wait",
        { runId: accepted.runId, timeoutMs: 45_000 },
        { timeoutMs: 50_000 },
      );
      return { sessionKey, accepted, completed, frames: frames.slice(started) };
    };
    try {
      const retained = await send("retained");
      expect(nodeFault).toBeUndefined();
      expect(approvalFault).toBeUndefined();
      expect(retained.accepted.status).toBe("started");
      expect(retained.completed.status).toBe("ok");
      expect(retained.frames).toContain(NODE_AGENT_CLI_CLAUDE_RUN_COMMAND);
      const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey: retained.sessionKey,
      });
      expect(history.messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([{ type: "text", text: "Node account reply." }]),
        }),
      );
      trace(
        `retained account: chat.send finished ok; node frames=${retained.frames.length}; approvals=${approvalIds.length}`,
      );

      approvalIds.length = 0;
      approvalMode = "remove";
      const removed = await send("removed");
      expect(nodeFault).toBeUndefined();
      expect(approvalFault).toBeUndefined();
      expect(removed.completed.status).toBe("error");
      expect(removed.completed.error ?? "").toContain("was removed");
      expect(removed.completed.error ?? "").toContain("did not submit this turn");
      expect(removed.frames).toEqual([NODE_AGENT_CLI_CLAUDE_RUN_COMMAND]);
      expect(approvalIds).toHaveLength(1);
      trace(
        "approval retry: account removed while the Gateway approval was pending; node frames=1 and no second invoke",
      );
    } finally {
      await approver.stopAndWait();
      await node.stopAndWait();
      await gateway.client.stopAndWait();
      await gateway.server.close({ reason: "node account turn finished" });
      await state.cleanup();
    }
  },
);
