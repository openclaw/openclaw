/**
 * `openclaw fabric ask` — Command Handler
 *
 * Sends an A2A message to a Cloud.ru AI Fabric agent or agent system.
 * Resolves the target by name or ID, computes the A2A endpoint,
 * and prints the response to stdout.
 *
 * Reusable across: CLI, skill-generated commands, gateway hooks.
 */

import type { Addressable } from "../ai-fabric/resolve-agent.js";
import { normalizeAgentStatus } from "../ai-fabric/agent-status.js";
import { normalizeAgentSystemStatus } from "../ai-fabric/agent-system-status.js";
import { CloudruA2AClient, A2AError } from "../ai-fabric/cloudru-a2a-client.js";
import { CloudruSimpleClient } from "../ai-fabric/cloudru-client-simple.js";
import {
  resolveAddressable,
  agentToAddressable,
  agentSystemToAddressable,
  computeEndpoint,
} from "../ai-fabric/resolve-agent.js";
import { resolveIamSecret } from "../ai-fabric/resolve-iam-secret.js";
import { loadConfig } from "../config/config.js";

export type FabricAskParams = {
  /** Target agent/system name or ID. */
  target: string;
  /** Message to send. */
  message: string;
};

export type FabricAskResult =
  | { ok: true; text: string; targetName: string; targetKind: string }
  | { ok: false; error: string };

/**
 * Core logic for `openclaw fabric ask`.
 * Returns structured result — caller decides how to output.
 */
export async function fabricAsk(params: FabricAskParams): Promise<FabricAskResult> {
  const config = loadConfig();
  const aiFabric = config.aiFabric;

  if (!aiFabric?.enabled) {
    return { ok: false, error: "AI Fabric is not enabled. Run `openclaw onboard` to configure." };
  }

  const projectId = aiFabric.projectId ?? "";
  const keyId = aiFabric.keyId ?? "";
  const secret = resolveIamSecret();

  if (!projectId || !keyId || !secret) {
    return {
      ok: false,
      error:
        "AI Fabric credentials incomplete. Ensure aiFabric.projectId, aiFabric.keyId, and CLOUDRU_IAM_SECRET are set.",
    };
  }

  const authParams = { keyId, secret };
  const client = new CloudruSimpleClient({ projectId, auth: authParams });

  // Discover agents + agent systems
  let addressables: Addressable[];
  try {
    const [agentsResult, systemsResult] = await Promise.all([
      client.listAgents({ limit: 100 }),
      client.listAgentSystems({ limit: 100 }),
    ]);

    const agents = agentsResult.data
      .filter((a) => {
        const s = normalizeAgentStatus(a.status);
        return s !== "DELETED" && s !== "ON_DELETION";
      })
      .map(agentToAddressable);

    const systems = systemsResult.data
      .filter((s) => {
        const st = normalizeAgentSystemStatus(s.status);
        return st !== "DELETED" && st !== "ON_DELETION";
      })
      .map(agentSystemToAddressable);

    addressables = [...agents, ...systems];
  } catch (err) {
    return { ok: false, error: `Failed to list resources: ${(err as Error).message}` };
  }

  // Resolve target
  const resolved = resolveAddressable(addressables, params.target);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const target = resolved.target;
  const endpoint = computeEndpoint(target);

  // Send A2A message (120s timeout for agent systems with cold start)
  try {
    const a2aClient = new CloudruA2AClient({ auth: authParams, timeoutMs: 120_000 });
    const result = await a2aClient.sendMessage({
      endpoint,
      message: params.message,
    });

    return {
      ok: true,
      text: result.text,
      targetName: target.name,
      targetKind: target.kind,
    };
  } catch (err) {
    if (err instanceof A2AError) {
      return {
        ok: false,
        error: `A2A error (${target.name} at ${endpoint}): ${err.message}`,
      };
    }
    return { ok: false, error: `Unexpected error: ${(err as Error).message}` };
  }
}
