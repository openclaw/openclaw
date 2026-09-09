import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import {
  isApprovedRouterStateRoot,
  isHostOnlyOpenClawPath,
  normalizePathForRouterSafeGuard,
  resolveRouterSafePreparedRuntimePaths,
} from "../../agents/router-safe-prepared-runtime-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";

export const ROUTER_SAFE_ROUTED_DISPATCH_MARKER = "routerSafeRoutedDispatchStateRoot";

export type RouterSafeRoutedDispatchPaths = {
  workspaceDir: string;
  agentDir: string;
  diagnostics: {
    marker: typeof ROUTER_SAFE_ROUTED_DISPATCH_MARKER;
    agentId: string;
    surface: string;
    stateRoot: string;
    hostOnlyWorkspace: boolean;
    hostOnlyAgentDir: boolean;
    source: "configured" | "prepared";
  };
};

export class RouterSafeRoutedDispatchPathError extends Error {
  readonly diagnostics: {
    marker: typeof ROUTER_SAFE_ROUTED_DISPATCH_MARKER;
    agentId: string;
    surface: string;
    reason: "missing-approved-state-root" | "unsafe-approved-state-root";
    stateRoot?: string;
    hostOnlyWorkspace: boolean;
    hostOnlyAgentDir: boolean;
    source: "configured" | "prepared";
  };

  constructor(diagnostics: RouterSafeRoutedDispatchPathError["diagnostics"]) {
    super(
      `router routed dispatch blocked: ${diagnostics.reason} agentId=${diagnostics.agentId} surface=${diagnostics.surface}`,
    );
    this.name = "RouterSafeRoutedDispatchPathError";
    this.diagnostics = diagnostics;
  }
}

export function resolveRoutedDispatchSurface(
  ctx: Pick<FinalizedRuntimeMsgContext, "Surface" | "OriginatingChannel" | "Provider">,
): string | undefined {
  return (
    normalizeOptionalString(ctx.Surface) ??
    normalizeOptionalString(ctx.OriginatingChannel) ??
    normalizeOptionalString(ctx.Provider)
  );
}

export function resolveRouterSafeRoutedDispatchPaths(params: {
  cfg: OpenClawConfig;
  agentId: string;
  surface?: string | null;
  env?: NodeJS.ProcessEnv;
  preparedWorkspaceDir?: string;
  preparedAgentDir?: string;
}): RouterSafeRoutedDispatchPaths | undefined {
  const surface = normalizeOptionalString(params.surface)?.toLowerCase();
  if (surface !== "msteams") {
    return undefined;
  }
  const agentId = params.agentId;
  const agent = resolveAgentConfig(params.cfg, agentId);
  const configuredWorkspace = normalizeOptionalString(agent?.workspace);
  const configuredAgentDir = normalizeOptionalString(agent?.agentDir);
  const preparedWorkspace = normalizeOptionalString(params.preparedWorkspaceDir);
  const preparedAgentDir = normalizeOptionalString(params.preparedAgentDir);
  const workspaceCandidate = preparedWorkspace ?? configuredWorkspace;
  const agentDirCandidate = preparedAgentDir ?? configuredAgentDir;
  const hostOnlyWorkspace = isHostOnlyOpenClawPath(workspaceCandidate);
  const hostOnlyAgentDir = isHostOnlyOpenClawPath(agentDirCandidate);
  if (!hostOnlyWorkspace && !hostOnlyAgentDir) {
    return undefined;
  }
  const source = preparedWorkspace || preparedAgentDir ? "prepared" : "configured";

  const paths = resolveRouterSafePreparedRuntimePaths({
    agentId,
    workspaceDir: workspaceCandidate,
    agentDir: agentDirCandidate,
    env: params.env,
    source,
    failClosed: false,
  });
  if (!paths) {
    throw new RouterSafeRoutedDispatchPathError({
      marker: ROUTER_SAFE_ROUTED_DISPATCH_MARKER,
      agentId,
      surface,
      reason: "missing-approved-state-root",
      hostOnlyWorkspace,
      hostOnlyAgentDir,
      source,
    });
  }
  if (!isApprovedRouterStateRoot(paths.diagnostics.stateRoot)) {
    throw new RouterSafeRoutedDispatchPathError({
      marker: ROUTER_SAFE_ROUTED_DISPATCH_MARKER,
      agentId,
      surface,
      reason: "unsafe-approved-state-root",
      stateRoot: normalizePathForRouterSafeGuard(paths.diagnostics.stateRoot),
      hostOnlyWorkspace,
      hostOnlyAgentDir,
      source,
    });
  }

  return {
    workspaceDir: paths.workspaceDir,
    agentDir: paths.agentDir,
    diagnostics: {
      marker: ROUTER_SAFE_ROUTED_DISPATCH_MARKER,
      agentId,
      surface,
      stateRoot: paths.diagnostics.stateRoot,
      hostOnlyWorkspace,
      hostOnlyAgentDir,
      source,
    },
  };
}
