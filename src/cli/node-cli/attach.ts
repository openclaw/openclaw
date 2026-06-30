// `openclaw attach` on a NODE machine: reach the gateway over the node's own (already-approved) link
// and run the node-side attach conduit, rather than the gateway-host loopback path
// (src/cli/attach-cli.ts). Connects as the paired node — token is the auth, so the gateway's
// node.attachGrant entitlement gate (owner-approved `attach` permission) is what authorizes the
// grant — runs prepareNodeAttach (grant + hydrate + loopback forwarder), and returns a launch plan
// the attach command spawns Claude Code against. node-host imports live here in node-cli (the cli
// layer permitted to depend on node-host), not in the plain attach command.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../../config/config.js";
import { startGatewayClientWhenEventLoopReady } from "../../gateway/client-start-readiness.js";
import { GatewayClient } from "../../gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { prepareNodeAttach } from "../../node-host/attach.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { resolveNodeHostGatewayCredentials } from "../../node-host/runner.js";

/** A node-conduit launch plan: what `openclaw attach` needs to spawn Claude Code + tear down after. */
export type NodeAttachPlan = {
  sessionKey: string;
  mcpConfig: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
  /** `--resume <id>` (hydrated) or `--session-id <id>` (fresh) — appended to the claude argv. */
  launchArgs: string[];
  /** Tears down the forwarder + the node gateway connection. Idempotent-safe to await once. */
  close: () => Promise<void>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function closeGatewayClient(client: unknown): Promise<void> {
  const c = client as { close?: () => unknown; disconnect?: () => unknown };
  try {
    await (c.close?.() ?? c.disconnect?.());
  } catch {
    // best-effort teardown
  }
}

/**
 * Bring up the node-conduit attach for this machine's paired node. The caller (the attach command)
 * owns spawning Claude Code with the returned plan and awaiting `close()` on exit.
 */
export async function runNodeAttach(params: {
  cwd: string;
  nowMs: number;
}): Promise<NodeAttachPlan> {
  const nodeConfig = await loadNodeHostConfig();
  if (!nodeConfig) {
    throw new Error(
      "no node-host config found — run on a paired node (or use --via gateway on the gateway host)",
    );
  }
  const cfg = getRuntimeConfig();
  const { token, password } = await resolveNodeHostGatewayCredentials({
    config: cfg,
    env: process.env,
  });
  const gw = nodeConfig.gateway ?? {};
  const url = `${gw.tls ? "wss" : "ws"}://${gw.host ?? "127.0.0.1"}:${gw.port ?? 18789}`;

  // Connect as the paired node. caps/commands are intentionally omitted so the approved surface is
  // preserved, but the attach permission must be declared on this live connection so gateway
  // reconciliation can intersect it with the stored owner approval.
  const client = new GatewayClient({
    url,
    token: token || undefined,
    password: password || undefined,
    instanceId: nodeConfig.nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: nodeConfig.displayName ?? nodeConfig.nodeId,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    permissions: { attach: true },
    deviceIdentity: loadOrCreateDeviceIdentity(),
    tlsFingerprint: gw.tlsFingerprint,
    onEvent: () => {},
    onConnectError: () => {},
    onClose: () => {},
  });

  const readiness = await startGatewayClientWhenEventLoopReady(client, {});
  if (!readiness.ready) {
    await closeGatewayClient(client);
    throw new Error("openclaw attach (node): gateway client event loop did not become ready");
  }
  // Event-loop readiness is not the WS connection; wait until a node request actually lands. Only the
  // transient "not connected (yet)" is worth retrying — auth/scope/pairing failures won't self-heal,
  // so break fast on them and surface the real cause instead of a generic ~10s timeout.
  let connected = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await client.request("skills.bins", {});
      connected = true;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/not connected/i.test(message)) {
        break; // non-transient (bad/expired token, not paired, missing scope) — don't spin
      }
      await sleep(200);
    }
  }
  if (!connected) {
    await closeGatewayClient(client);
    const detail = lastError instanceof Error ? lastError.message : "unknown";
    throw new Error(
      `openclaw attach (node): could not reach the gateway over the node link — ${detail}`,
    );
  }

  const launch = await prepareNodeAttach({ client, cwd: params.cwd, nowMs: params.nowMs });
  return {
    sessionKey: launch.sessionKey,
    mcpConfig: launch.mcpConfig,
    env: launch.env,
    launchArgs: launch.launchArgs,
    close: async () => {
      // Revoke the grant first (node-path symmetry to the gateway-host attach.revoke — a node can't
      // call that operator.admin method) while the link is still up; then tear down forwarder + link.
      // All best-effort: the grant's TTL still bounds it if revoke can't be delivered.
      try {
        await client.request("node.attachRevoke", { grantToken: launch.env.OPENCLAW_MCP_TOKEN });
      } catch {
        // best-effort
      }
      try {
        await launch.forwarder.close();
      } catch {
        // best-effort
      }
      await closeGatewayClient(client);
    },
  };
}
