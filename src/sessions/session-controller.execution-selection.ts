import { isDeepStrictEqual } from "node:util";
import {
  resolveAgentConfig,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveSessionAuthProfileOverrideSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ExecutionSelectionEntry = Pick<
  SessionEntry,
  | "execHost"
  | "execNode"
  | "execCwd"
  | "elevatedLevel"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "spawnedWorkspaceDir"
  | "spawnedCwd"
  | "sessionRoot"
  | "agentRuntimeOverride"
  | "agentHarnessId"
  | "modelSelectionLocked"
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
>;

type ExecutionSelectionRun = {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  sessionFile: string;
  workspaceDir: string;
  cwd?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user" | "user-link";
};

/** Gateway input has admitted session/config facts before a new execution is assembled. */
export function captureReplySessionExecutionSelection(params: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  sessionEntry: Partial<ExecutionSelectionEntry> | undefined;
}) {
  const { config: cfg, agentId, sessionEntry } = params;
  const agent = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const authSource = resolveSessionAuthProfileOverrideSource(sessionEntry);
  const explicitAuth = authSource === "user" || authSource === "user-link";
  return structuredClone({
    kind: "session" as const,
    agentId,
    session: {
      execHost: sessionEntry?.execHost,
      execNode: sessionEntry?.execNode,
      execCwd: sessionEntry?.execCwd,
      elevatedLevel: sessionEntry?.elevatedLevel,
      spawnedWorkspaceDir: sessionEntry?.spawnedWorkspaceDir,
      spawnedCwd: sessionEntry?.spawnedCwd,
      sessionRoot: sessionEntry?.sessionRoot,
      agentRuntimeOverride: sessionEntry?.agentRuntimeOverride,
      agentHarnessId: sessionEntry?.agentHarnessId,
      modelSelectionLocked: sessionEntry?.modelSelectionLocked,
      model:
        sessionEntry?.modelOverrideSource !== "auto" &&
        (sessionEntry?.providerOverride ||
          sessionEntry?.modelOverride ||
          sessionEntry?.modelOverrideSource)
          ? {
              provider: sessionEntry.providerOverride,
              model: sessionEntry.modelOverride,
              source: sessionEntry.modelOverrideSource,
            }
          : undefined,
      // Credential rotation has no bearing on the selected execution. Explicit pins do.
      authProfile: explicitAuth
        ? { id: sessionEntry?.authProfileOverride, source: authSource }
        : undefined,
    },
    configuration: cfg
      ? {
          globalExec: cfg.tools?.exec,
          agentExec: agent?.tools?.exec,
          globalElevation: cfg.tools?.elevated,
          agentElevation: agent?.tools?.elevated,
          elevatedDefault: cfg.agents?.defaults?.elevatedDefault,
          runtime: agent?.runtime,
          configuredWorkspace: agentId ? resolveAgentWorkspaceDir(cfg, agentId) : undefined,
          configuredCwd: agentId ? resolveAgentRunCwd(cfg, agentId) : undefined,
        }
      : undefined,
  });
}

/** Capture from the admitted producer, never from a later steering-time store read. */
export function captureReplyExecutionSelection(params: {
  run: ExecutionSelectionRun;
  sessionEntry: Partial<ExecutionSelectionEntry> | undefined;
}) {
  const { run } = params;
  const selectedAuth = run.authProfileId && run.authProfileIdSource !== "auto";
  return {
    kind: "execution" as const,
    binding: {
      agentDir: run.agentDir,
      sessionFile: run.sessionFile,
      workspaceDir: run.workspaceDir,
      cwd: run.cwd,
      authProfile: selectedAuth ? { id: run.authProfileId } : undefined,
    },
    session: captureReplySessionExecutionSelection({
      config: run.config,
      agentId: run.agentId,
      sessionEntry: params.sessionEntry,
    }),
  };
}

/** Private, immutable-by-capture input to the existing authority owner's join check. */
export type ReplyExecutionSelection = ReturnType<typeof captureReplyExecutionSelection>;
export type ReplyIncomingExecutionSelection =
  | ReplyExecutionSelection
  | ReturnType<typeof captureReplySessionExecutionSelection>;

export function isSameReplyExecutionSelection(
  left: ReplyExecutionSelection,
  right: ReplyIncomingExecutionSelection,
): boolean {
  return right.kind === "execution"
    ? isDeepStrictEqual(left, right)
    : isDeepStrictEqual(left.session, right);
}
