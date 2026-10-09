import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type IncognitoSessionPolicyFacts = Pick<
  SessionEntry,
  | "sessionId"
  | "sandbox"
  | "sandboxMode"
  | "createdActor"
  | "agentRuntimeOverride"
  | "nativeRuntimeConsent"
  | "permissionMode"
  | "execHost"
  | "execNode"
  | "execCwd"
  | "skillLibrarySelections"
  | "pluginOwnerId"
  | "agentHarnessId"
>;

/** Publish only the fields needed by synchronous policy guards. */
export function projectIncognitoSessionPolicyFacts(
  entry: SessionEntry | undefined,
): IncognitoSessionPolicyFacts | undefined {
  return (
    entry && {
      sessionId: entry.sessionId,
      sandbox: entry.sandbox,
      sandboxMode: entry.sandboxMode,
      createdActor: entry.createdActor,
      agentRuntimeOverride: entry.agentRuntimeOverride,
      nativeRuntimeConsent: entry.nativeRuntimeConsent,
      permissionMode: entry.permissionMode,
      execHost: entry.execHost,
      execNode: entry.execNode,
      execCwd: entry.execCwd,
      skillLibrarySelections: entry.skillLibrarySelections,
      pluginOwnerId: entry.pluginOwnerId,
      agentHarnessId: entry.agentHarnessId,
    }
  );
}
