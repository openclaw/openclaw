// Node-side attach orchestration (PR5 conduit + PR7 hydration). Ties the pieces a paired node needs
// to attach a local harness to its gateway session, entirely over the node's EXISTING gateway link:
//   1. node.attachGrant   — self-service grant for the node's main session (pairing = authz)
//   2. node.attachHydrate — the gateway-owned conversation for that session
//   3. hydrate it into a fresh local Claude transcript so `claude --resume` continues it anywhere
//   4. start the loopback forwarder -> node.attachRelay
//   5. hand back the launch config (forwarder MCP url + token env + the --resume args)
import { randomUUID } from "node:crypto";
import {
  type HydrationMessage,
  hydrateClaudeCliTranscript,
} from "../gateway/cli-session-hydrate.claude.js";
import { type NodeAttachForwarder, startNodeAttachForwarder } from "./attach-forwarder.js";

type AttachClient = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

export type NodeAttachLaunch = {
  sessionKey: string;
  /** The fresh cli session id the hydrated transcript was written under; what `--resume` targets. */
  cliSessionId: string;
  forwarder: NodeAttachForwarder;
  mcpConfig: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
  /** `["--resume", id]` when a transcript was hydrated, else `["--session-id", id]` (fresh session). */
  launchArgs: string[];
  transcriptPath: string | undefined;
};

export async function prepareNodeAttach(params: {
  client: AttachClient;
  cwd: string;
  nowMs: number;
  homeDir?: string;
}): Promise<NodeAttachLaunch> {
  const { client, cwd, nowMs, homeDir } = params;
  const grant = await client.request<{ sessionKey: string; token: string; expiresAtMs: number }>(
    "node.attachGrant",
    {},
  );
  const { messages } = await client.request<{ messages: HydrationMessage[] }>(
    "node.attachHydrate",
    {
      grantToken: grant.token,
    },
  );
  // Fresh local cli session id; hydrate the gateway conversation under it so --resume picks it up.
  const cliSessionId = randomUUID();
  const transcriptPath = hydrateClaudeCliTranscript({
    messages: Array.isArray(messages) ? messages : [],
    sessionId: cliSessionId,
    cwd,
    nowMs,
    homeDir,
  });
  const forwarder = await startNodeAttachForwarder({ client });
  return {
    sessionKey: grant.sessionKey,
    cliSessionId,
    forwarder,
    // The harness's MCP client points at the LOCAL forwarder; the token rides the env placeholder so
    // it never lands in argv or a durable config, mirroring the gateway-host launcher (PR2).
    mcpConfig: {
      mcpServers: {
        openclaw: {
          type: "http",
          url: forwarder.url,
          headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
        },
      },
    },
    env: { OPENCLAW_MCP_TOKEN: grant.token, OPENCLAW_MCP_SESSION_KEY: grant.sessionKey },
    launchArgs: transcriptPath ? ["--resume", cliSessionId] : ["--session-id", cliSessionId],
    transcriptPath,
  };
}
