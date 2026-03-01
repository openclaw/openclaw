import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/tool-permissions");

const TOOL_PERMISSIONS_PATH = "01_agent_os/core/tool_permissions.yaml";
const SUBAGENTS_REGISTRY_PATH = "01_agent_os/behavior/subagents_registry.yaml";

const EXECUTIVE_AGENT_IDS = new Set(["main", "executive_orchestrator", "don_cordazzo"]);

type ToolPermissionsFile = {
  executive_orchestrator?: {
    allowed_tools?: string[];
    forbidden_tools?: string[];
    write_scopes?: string[];
    max_pages?: number;
  };
};

type SubagentsRegistryFile = {
  subagents?: Array<{
    subagent_id?: string;
    allowed_tools?: string[];
    forbidden_tools?: string[];
    write_scopes?: string[];
    max_pages?: number;
  }>;
};

export type ToolPermissionContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
};

type PermissionContracts = {
  executive?: ToolPermissionsFile["executive_orchestrator"];
  subagents?: SubagentsRegistryFile["subagents"];
};

type ContractLoadState = {
  contracts?: PermissionContracts;
  strictMode: boolean;
  hasRegistry: boolean;
  errors: string[];
};

type CacheEntry = {
  signature: string;
  state: ContractLoadState;
};

export type ActorPermissionPolicy = {
  actor: string;
  allowedTools: Set<string>;
  forbiddenTools: Set<string>;
  writeScopes: string[];
  maxPages: number;
};

export type ToolPermissionDecision = {
  blocked: boolean;
  reason?: string;
  actor?: string;
  permissionTool: string;
};

const contractsCache = new Map<string, CacheEntry>();

function normalizePermissionToken(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim().toLowerCase();
  }
  return "";
}

function parseYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return parseYaml(raw) as T;
}

function safeFileSignature(path: string): string {
  if (!existsSync(path)) {
    return "missing";
  }
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "error";
  }
}

function resolveContractLoadState(workspaceDir?: string): ContractLoadState {
  if (!workspaceDir) {
    return {
      strictMode: false,
      hasRegistry: false,
      errors: [],
    };
  }
  const toolPermissionsPath = join(workspaceDir, TOOL_PERMISSIONS_PATH);
  const subagentsRegistryPath = join(workspaceDir, SUBAGENTS_REGISTRY_PATH);
  const signature = `${safeFileSignature(toolPermissionsPath)}|${safeFileSignature(subagentsRegistryPath)}`;
  const cached = contractsCache.get(workspaceDir);
  if (cached && cached.signature === signature) {
    return cached.state;
  }

  const hasToolPermissions = existsSync(toolPermissionsPath);
  const hasRegistry = existsSync(subagentsRegistryPath);
  const strictMode = hasToolPermissions || hasRegistry;
  const errors: string[] = [];
  let toolPermissions: ToolPermissionsFile | undefined;
  let subagentsRegistry: SubagentsRegistryFile | undefined;

  if (hasToolPermissions) {
    try {
      toolPermissions = parseYamlFile<ToolPermissionsFile>(toolPermissionsPath);
    } catch (err) {
      errors.push(`failed to parse ${TOOL_PERMISSIONS_PATH}: ${String(err)}`);
    }
  }
  if (hasRegistry) {
    try {
      subagentsRegistry = parseYamlFile<SubagentsRegistryFile>(subagentsRegistryPath);
    } catch (err) {
      errors.push(`failed to parse ${SUBAGENTS_REGISTRY_PATH}: ${String(err)}`);
    }
  }

  const state: ContractLoadState = {
    strictMode,
    hasRegistry,
    errors,
    contracts:
      !toolPermissions && !subagentsRegistry
        ? undefined
        : {
            executive: toolPermissions?.executive_orchestrator,
            subagents: subagentsRegistry?.subagents,
          },
  };
  contractsCache.set(workspaceDir, {
    signature,
    state,
  });
  return state;
}

function toActorPolicy(params: {
  actor: string;
  value?: {
    allowed_tools?: string[];
    forbidden_tools?: string[];
    write_scopes?: string[];
    max_pages?: number;
  };
}): ActorPermissionPolicy {
  return {
    actor: params.actor,
    allowedTools: new Set((params.value?.allowed_tools ?? []).map(normalizePermissionToken)),
    forbiddenTools: new Set((params.value?.forbidden_tools ?? []).map(normalizePermissionToken)),
    writeScopes: params.value?.write_scopes ?? [],
    maxPages: Number(params.value?.max_pages ?? 0),
  };
}

export function resolveActorPermissionPolicy(
  ctx?: ToolPermissionContext,
): ActorPermissionPolicy | undefined {
  const state = resolveContractLoadState(ctx?.workspaceDir);
  if (!state.contracts) {
    return undefined;
  }
  const normalizedAgentId = normalizePermissionToken(ctx?.agentId);
  if (!normalizedAgentId) {
    return undefined;
  }
  if (EXECUTIVE_AGENT_IDS.has(normalizedAgentId)) {
    return toActorPolicy({
      actor: "executive_orchestrator",
      value: state.contracts.executive,
    });
  }
  const subagent = (state.contracts.subagents ?? []).find(
    (entry) => normalizePermissionToken(entry?.subagent_id) === normalizedAgentId,
  );
  if (!subagent) {
    return undefined;
  }
  return toActorPolicy({
    actor: normalizedAgentId,
    value: subagent,
  });
}

function shouldRequireContractsForAgent(args: {
  agentId: string;
  state: ContractLoadState;
}): boolean {
  if (EXECUTIVE_AGENT_IDS.has(args.agentId)) {
    return true;
  }
  if (args.state.hasRegistry) {
    return true;
  }
  return false;
}

export function assertPermissionContractsReadyForActor(ctx?: ToolPermissionContext): void {
  const normalizedAgentId = normalizePermissionToken(ctx?.agentId);
  if (!ctx?.workspaceDir || !normalizedAgentId) {
    return;
  }
  const state = resolveContractLoadState(ctx.workspaceDir);
  if (!state.strictMode) {
    return;
  }
  if (
    state.errors.length > 0 &&
    shouldRequireContractsForAgent({ agentId: normalizedAgentId, state })
  ) {
    const reason = state.errors.join("; ");
    throw new Error(`tool permission contracts invalid: ${reason}`);
  }
  if (EXECUTIVE_AGENT_IDS.has(normalizedAgentId) && !state.contracts?.executive) {
    throw new Error(
      `tool permission contracts invalid: missing executive policy in ${TOOL_PERMISSIONS_PATH}`,
    );
  }
}

export function mapRuntimeToolToPermission(toolName: string): string {
  switch (toolName) {
    case "browser":
      return "web_browsing";
    case "message":
    case "sessions_send":
      return "send_message";
    case "read":
      return "file_read";
    case "write":
    case "edit":
    case "apply_patch":
      return "file_write";
    default:
      return toolName;
  }
}

function parseWritePath(toolName: string, params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const pathLike =
    record.file_path ?? record.path ?? record.target_file ?? record.output_path ?? record.filename;
  if (typeof pathLike === "string" && pathLike.trim().length > 0) {
    return pathLike.trim();
  }
  if (toolName !== "apply_patch") {
    return undefined;
  }
  const input = record.input;
  if (typeof input !== "string") {
    return undefined;
  }
  const match = input.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/m);
  if (!match) {
    return undefined;
  }
  return match[1].trim();
}

function writePathAllowed(writePath: string, scopes: string[]): boolean {
  const normalized = writePath.trim().replace(/^\/+/, "");
  return scopes.some((scope) => normalized.startsWith(scope.trim().replace(/^\/+/, "")));
}

export function evaluateToolPermission(args: {
  toolName: string;
  params: unknown;
  ctx?: ToolPermissionContext;
  actorWebPageUsage?: Map<string, number>;
  countWebUsage?: boolean;
}): ToolPermissionDecision {
  const normalizedAgentId = normalizePermissionToken(args.ctx?.agentId);
  const state = resolveContractLoadState(args.ctx?.workspaceDir);
  const permissionTool = mapRuntimeToolToPermission(args.toolName);
  if (normalizedAgentId && state.errors.length > 0) {
    if (shouldRequireContractsForAgent({ agentId: normalizedAgentId, state })) {
      return {
        blocked: true,
        reason: `tool permission contracts invalid: ${state.errors.join("; ")}`,
        actor: normalizedAgentId,
        permissionTool,
      };
    }
  }
  if (
    normalizedAgentId &&
    state.strictMode &&
    EXECUTIVE_AGENT_IDS.has(normalizedAgentId) &&
    !state.contracts?.executive
  ) {
    return {
      blocked: true,
      reason: `tool permission contracts invalid: missing executive policy in ${TOOL_PERMISSIONS_PATH}`,
      actor: normalizedAgentId,
      permissionTool,
    };
  }
  const actorPolicy = resolveActorPermissionPolicy(args.ctx);
  if (!actorPolicy) {
    return {
      blocked: false,
      permissionTool,
    };
  }
  if (actorPolicy.forbiddenTools.has(permissionTool)) {
    return {
      blocked: true,
      reason: `forbidden by actor policy (${actorPolicy.actor}): ${permissionTool}`,
      actor: actorPolicy.actor,
      permissionTool,
    };
  }
  if (actorPolicy.allowedTools.size > 0 && !actorPolicy.allowedTools.has(permissionTool)) {
    return {
      blocked: true,
      reason: `tool not allowed for ${actorPolicy.actor}: ${permissionTool}`,
      actor: actorPolicy.actor,
      permissionTool,
    };
  }
  if (permissionTool === "web_browsing") {
    if (actorPolicy.maxPages <= 0) {
      return {
        blocked: true,
        reason: `web browsing disabled for ${actorPolicy.actor}`,
        actor: actorPolicy.actor,
        permissionTool,
      };
    }
    if (args.countWebUsage !== false && args.actorWebPageUsage) {
      const actorKey = `${actorPolicy.actor}:${args.ctx?.sessionKey ?? "session"}`;
      const used = args.actorWebPageUsage.get(actorKey) ?? 0;
      const next = used + 1;
      if (next > actorPolicy.maxPages) {
        return {
          blocked: true,
          reason: `max pages exceeded for ${actorPolicy.actor}: ${next}>${actorPolicy.maxPages}`,
          actor: actorPolicy.actor,
          permissionTool,
        };
      }
      args.actorWebPageUsage.set(actorKey, next);
    }
  }
  if (permissionTool === "file_write") {
    const writePath = parseWritePath(args.toolName, args.params);
    if (!writePath) {
      return {
        blocked: true,
        reason: `missing write path for scoped actor ${actorPolicy.actor}`,
        actor: actorPolicy.actor,
        permissionTool,
      };
    }
    if (
      actorPolicy.writeScopes.length > 0 &&
      !writePathAllowed(writePath, actorPolicy.writeScopes)
    ) {
      return {
        blocked: true,
        reason: `write scope violation for ${actorPolicy.actor}: ${writePath}`,
        actor: actorPolicy.actor,
        permissionTool,
      };
    }
  }
  return {
    blocked: false,
    actor: actorPolicy.actor,
    permissionTool,
  };
}

export function assertActorCanSendMessage(ctx?: ToolPermissionContext): void {
  const decision = evaluateToolPermission({
    toolName: "message",
    params: {},
    ctx,
    countWebUsage: false,
  });
  if (!decision.blocked) {
    return;
  }
  log.warn(
    `send blocked by actor policy: actor=${decision.actor ?? "unknown"} reason=${decision.reason ?? "unknown"}`,
  );
  throw new Error(decision.reason ?? "send blocked by actor policy");
}

export const __testing = {
  clearContractsCache: () => contractsCache.clear(),
};
