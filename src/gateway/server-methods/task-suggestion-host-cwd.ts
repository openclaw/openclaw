// Host-path resolution for task suggestion cwd values recorded inside sandboxes.
import fs from "node:fs";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxFsMount,
} from "../../agents/sandbox/fs-paths.js";
import type { SandboxMountRootHandoff } from "../../agents/sandbox/mount-root-handoff.js";
import type { SandboxWorkspaceInfo } from "../../agents/sandbox/types.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayClient } from "./types.js";

function isExistingHostDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function unavailableTaskSuggestionCwdError(params: {
  cwd: string;
  mappedHostCwd?: string;
  hostWorkspaceDir: string;
  containerWorkdir?: string;
}): ErrorShape {
  const unresolved = params.mappedHostCwd
    ? `${params.cwd} maps to ${params.mappedHostCwd} in the sandbox workspace, but that path is missing on the host`
    : `${params.cwd} is missing on the host`;
  const hint = params.containerWorkdir
    ? `use a host path under ${params.hostWorkspaceDir} or a container path under ${params.containerWorkdir}`
    : `use a host path under ${params.hostWorkspaceDir}`;
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `task suggestion cwd is unavailable: ${unresolved}; sandboxed sessions run in a container, so ${hint}.`,
  );
}

/**
 * Source-session facts the live run already knows: the workspace sandbox
 * setup mounts, plus the skill snapshot it resolves the sandbox with.
 * Nonempty library selections pick a separate isolation subject and
 * workspace, so resolving without them points /workspace at the wrong tree.
 */
function resolveSourceSessionFacts(params: { sessionKey: string; agentId: string }): {
  workspaceDir?: string;
  skillsSnapshot?: SkillSnapshot;
} {
  try {
    const entry = loadGatewaySessionEntryReadOnly(params.sessionKey, {
      agentId: params.agentId,
    }).entry;
    const workspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: entry?.spawnedBy,
      workspaceDir: entry?.spawnedWorkspaceDir,
      cwd: entry?.spawnedCwd,
    });
    const skillsSnapshot = entry?.skillsSnapshot;
    return {
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(skillsSnapshot?.librarySelections?.length ? { skillsSnapshot } : {}),
    };
  } catch {
    // An unreadable store leaves the configured agent workspace in charge.
    return {};
  }
}

/**
 * Mount table the source session's container sees. Precedence belongs to the
 * mount layer (nested binds beat the workspace root), and the table owns
 * containment, so a path outside every mount stays unresolved instead of being
 * guessed from a container prefix.
 */
function buildSourceSandboxMounts(params: {
  sandbox: SandboxWorkspaceInfo;
  containerWorkdir: string;
}): SandboxFsMount[] {
  return buildSandboxFsMounts({
    workspaceDir: params.sandbox.workspaceDir,
    agentWorkspaceDir: params.sandbox.agentWorkspaceDir ?? params.sandbox.workspaceDir,
    ...(params.sandbox.skillsWorkspaceDir
      ? { skillsWorkspaceDir: params.sandbox.skillsWorkspaceDir }
      : {}),
    ...(params.sandbox.readOnlyResourceMounts
      ? { readOnlyResourceMounts: params.sandbox.readOnlyResourceMounts }
      : {}),
    workspaceAccess: params.sandbox.workspaceAccess ?? "ro",
    containerName: "",
    containerWorkdir: params.containerWorkdir,
    docker: params.sandbox.dockerBinds ? { binds: [...params.sandbox.dockerBinds] } : {},
  });
}

/** Longest mount host root covering a host path, matching the table's own precedence. */
function findOwningMountHostRoot(
  mounts: readonly SandboxFsMount[],
  hostPath: string,
): string | undefined {
  let owner: string | undefined;
  for (const mount of mounts) {
    if (!isPathInside(mount.hostRoot, hostPath)) {
      continue;
    }
    if (owner === undefined || mount.hostRoot.length > owner.length) {
      owner = mount.hostRoot;
    }
  }
  return owner;
}

/**
 * Hand the owning mount root over to session creation. Session creation refuses
 * a sandboxed cwd outside the configured agent workspace, and the host
 * directories this mapping lands on (an isolated sandbox workspace, an external
 * bind target) are exactly the ones the sandbox layer mounts, so the marker
 * names that root for the roots the guard would refuse; creation re-derives it
 * before admitting the cwd.
 */
function resolveMountRootHandoff(params: {
  mounts: readonly SandboxFsMount[] | undefined;
  hostPath: string;
  agentId: string;
  agentWorkspaceDir: string;
}): SandboxMountRootHandoff | undefined {
  if (!params.mounts || isInsideAgentWorkspace(params.agentWorkspaceDir, params.hostPath)) {
    return undefined;
  }
  const hostRoot = findOwningMountHostRoot(params.mounts, params.hostPath);
  return hostRoot ? { kind: "sandbox-mount-root", agentId: params.agentId, hostRoot } : undefined;
}

/**
 * Containment reports the same configured agent workspace the creation guard
 * compares against, so an unreadable path must not decide the marker: the
 * consumer re-verifies the root either way.
 */
function isInsideAgentWorkspace(agentWorkspaceDir: string, hostPath: string): boolean {
  try {
    return isPathInside(fs.realpathSync(agentWorkspaceDir), fs.realpathSync(hostPath));
  } catch {
    return false;
  }
}

/** Map a recorded container cwd onto the host directory the sandbox mounts there. */
function mapCwdThroughSandboxMounts(params: {
  sandbox: SandboxWorkspaceInfo;
  mounts: SandboxFsMount[];
  containerWorkdir: string;
  cwd: string;
}): string | undefined {
  try {
    return resolveSandboxFsPathWithMounts({
      filePath: params.cwd,
      cwd: params.containerWorkdir,
      defaultWorkspaceRoot: params.sandbox.workspaceDir,
      defaultContainerRoot: params.containerWorkdir,
      mounts: params.mounts,
    }).hostPath;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the host directory a recorded cwd refers to. Sandboxed sessions see
 * container paths, so translate through the source session's effective
 * workspace and mounts; every other session keeps host cwd semantics.
 *
 * Callers choose the policy: acceptance that starts a host session refuses what
 * does not resolve, while task suggestion creation keeps the recorded path so
 * "start in this session" stays available.
 */
export async function resolveTaskSuggestionHostCwd(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  cwd: string;
  /**
   * Acceptance re-resolves the cwd creation already translated to the host.
   * Preserve that host identity for existing directories so overlapping
   * container prefixes cannot translate it a second time.
   */
  cwdAlreadyHostResolved?: boolean;
}): Promise<
  | { ok: true; cwd: string; mountRootHandoff?: SandboxMountRootHandoff }
  | { ok: false; error: ErrorShape }
> {
  const sourceFacts = resolveSourceSessionFacts(params);
  const configuredWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const hostWorkspaceDir = sourceFacts.workspaceDir ?? configuredWorkspaceDir;
  const sandbox = await resolveSourceSandboxWorkspace({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    hostWorkspaceDir,
    ...(sourceFacts.skillsSnapshot ? { skillsSnapshot: sourceFacts.skillsSnapshot } : {}),
  });
  const sandboxMounts =
    sandbox?.containerWorkdir && hasLocalSandboxMountContract(params.cfg, params.agentId)
      ? {
          sandbox,
          containerWorkdir: sandbox.containerWorkdir,
          mounts: buildSourceSandboxMounts({
            sandbox,
            containerWorkdir: sandbox.containerWorkdir,
          }),
        }
      : undefined;
  const handoffFor = (hostPath: string) =>
    resolveMountRootHandoff({
      mounts: sandboxMounts?.mounts,
      hostPath,
      agentId: params.agentId,
      agentWorkspaceDir: configuredWorkspaceDir,
    });
  if (params.cwdAlreadyHostResolved) {
    // A host path creation already resolved stays terminal: re-translating it
    // through container mounts could select a different existing directory
    // when the original target disappears. Containment still reports the root
    // the source sandbox mounts it from, which is what creation re-verifies.
    if (!isExistingHostDirectory(params.cwd)) {
      return {
        ok: false,
        error: unavailableTaskSuggestionCwdError({ cwd: params.cwd, hostWorkspaceDir }),
      };
    }
    const mountRootHandoff = handoffFor(params.cwd);
    return { ok: true, cwd: params.cwd, ...(mountRootHandoff ? { mountRootHandoff } : {}) };
  }
  if (!sandbox) {
    // Not a sandboxed session: host cwd semantics are unchanged.
    return { ok: true, cwd: params.cwd };
  }
  const mappedHostCwd = sandboxMounts
    ? mapCwdThroughSandboxMounts({
        sandbox: sandboxMounts.sandbox,
        mounts: sandboxMounts.mounts,
        containerWorkdir: sandboxMounts.containerWorkdir,
        cwd: params.cwd,
      })
    : undefined;
  const hostCwd = mappedHostCwd ?? params.cwd;
  if (isExistingHostDirectory(hostCwd)) {
    const mountRootHandoff = handoffFor(hostCwd);
    return { ok: true, cwd: hostCwd, ...(mountRootHandoff ? { mountRootHandoff } : {}) };
  }
  return {
    ok: false,
    error: unavailableTaskSuggestionCwdError({
      cwd: params.cwd,
      ...(mappedHostCwd ? { mappedHostCwd } : {}),
      hostWorkspaceDir: sandbox.workspaceDir,
      ...(sandbox.containerWorkdir ? { containerWorkdir: sandbox.containerWorkdir } : {}),
    }),
  };
}

/**
 * Resolve the source session's sandbox workspace and mounts. An unresolvable
 * sandbox layout still admits a path the host can resolve on its own; only the
 * recorded-broken case stays out of reach.
 */
async function resolveSourceSandboxWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  hostWorkspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<SandboxWorkspaceInfo | null> {
  try {
    return await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir: params.hostWorkspaceDir,
      ...(params.skillsSnapshot ? { skillsSnapshot: params.skillsSnapshot } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * Attach the mount-root handoff to the in-process creation request. Session
 * creation reads the handoff from the trusted creation provenance, which request
 * frames cannot carry; a caller without a client leaves it absent and the
 * containment guard keeps refusing the mapped root.
 */
export function withMountRootHandoff(
  client: GatewayClient | null,
  handoff: SandboxMountRootHandoff | undefined,
): GatewayClient | null {
  if (!client || !handoff) {
    return client;
  }
  return {
    ...client,
    internal: {
      ...client.internal,
      sessionCreation: {
        ...resolveOperatorSessionCreation(client, { allowTrustedHint: true }),
        sandboxMountRootHandoff: handoff,
      },
    },
  };
}

/**
 * Only local-container backends mount host directories into the sandbox, so
 * only their container paths may be translated back. Remote (ssh) backends own
 * a separately seeded remote workspace, and custom backends declare no local
 * mount contract here; mapping their workdir would select stale local files.
 * Source-session execution never reaches this mapping (it bypasses host
 * resolution), so skipping it only turns invented host paths into honest
 * unavailable-cwd errors at acceptance.
 */
// ponytail: allowlist, not capability probing — custom local-mount backends
// need an explicit entry here once they exist.
function hasLocalSandboxMountContract(cfg: OpenClawConfig, agentId: string): boolean {
  const backend = resolveSandboxConfigForAgent(cfg, agentId).backend;
  return backend === "docker" || backend === "podman";
}
