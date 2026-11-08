// Gateway-first routing for `openclaw skills ...` commands: the running Gateway owns skill
// state, and the CLI reads or writes locally only when no Gateway owns it.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveConfiguredAgentId,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope.js";
import { captureRuntimeConfigAsyncReader, readBestEffortConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import { canFallbackToImplicitLocalGateway } from "./gateway-rpc.js";

const GATEWAY_SKILLS_STATUS_TIMEOUT_MS = 1_500;
const GATEWAY_SKILLS_OFFLINE_LOCK_TIMEOUT_MS = 250;
const GATEWAY_SKILLS_MUTATION_TIMEOUT_MS = 30_000;

type ResolveSkillsWorkspaceOptions = {
  agentId?: string;
  bestEffort?: boolean;
};

export type ResolvedSkillsWorkspace = Awaited<ReturnType<typeof resolveSkillsWorkspace>>;

export async function callSkillsGateway<T>(params: {
  config: ResolvedSkillsWorkspace["config"];
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  const { callGateway } = await import("../gateway/call.js");
  return await callGateway<T>({
    timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
    ...params,
  });
}

export function normalizeExplicitAgentId(agentId?: string): string | undefined {
  const normalizedAgentId = agentId?.trim();
  if (agentId !== undefined && !normalizedAgentId) {
    throw new Error("--agent must not be blank");
  }
  if (!normalizedAgentId) {
    return undefined;
  }
  const canonical = normalizeAgentIdStrict(normalizedAgentId);
  return canonical.ok ? canonical.value : normalizedAgentId;
}

export async function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions) {
  // Prefer explicit --agent, then infer from cwd, then fall back to configured default agent.
  const config = options?.bestEffort
    ? await readBestEffortConfig({ observe: false, skipPluginValidation: true })
    : await captureRuntimeConfigAsyncReader()();
  const explicitAgentId = normalizeExplicitAgentId(options?.agentId);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, process.cwd());
  const agentId = explicitAgentId
    ? resolveConfiguredAgentId(config, explicitAgentId)
    : (inferredAgentId ??
      tryResolveLegacyCompatibilityAgentId(config) ??
      resolveDefaultAgentId(config, { surface: "the skills command", hint: "Pass --agent <id>." }));
  return {
    config,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

/**
 * Sends one `skills.*` request for the resolved agent. Reads fall back to `loadLocal` only
 * when the implicit local Gateway is unavailable. A mutation chooses its route before sending
 * and never replays locally: it runs here only while no Gateway owns the state lock.
 */
export async function routeSkillsCliRequest<T>(params: {
  resolved: ResolvedSkillsWorkspace;
  method: string;
  params: Record<string, unknown>;
  mutation: boolean;
  loadLocal: () => Promise<T>;
}): Promise<T> {
  const { resolved, loadLocal } = params;
  const request = {
    config: resolved.config,
    method: params.method,
    params: { agentId: resolved.agentId, ...params.params },
  };
  if (params.mutation) {
    const { isImplicitLocalGatewayTarget } = await import("../gateway/call.js");
    const { acquireGatewayLock } = await import("../infra/gateway-lock.js");
    const lock = (await isImplicitLocalGatewayTarget({ config: resolved.config }))
      ? await acquireGatewayLock({
          allowInTests: true,
          port: resolveGatewayPort(resolved.config, process.env),
          role: "sqlite-maintenance",
          timeoutMs: GATEWAY_SKILLS_OFFLINE_LOCK_TIMEOUT_MS,
        }).catch(() => undefined)
      : undefined;
    if (!lock) {
      return await callSkillsGateway<T>({
        ...request,
        timeoutMs: GATEWAY_SKILLS_MUTATION_TIMEOUT_MS,
      });
    }
    try {
      return await lock.run(loadLocal);
    } finally {
      await lock.release();
    }
  }
  try {
    return await callSkillsGateway<T>(request);
  } catch (error) {
    if (!(await canFallbackToImplicitLocalGateway({ config: resolved.config, error }))) {
      throw error;
    }
    return await loadLocal();
  }
}
