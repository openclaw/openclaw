import path from "node:path";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type { SessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";
import type { SessionExactEntriesWorkerSelection } from "./session-entry-read.types.js";
import {
  captureIncognitoSessionBinding,
  captureIncognitoSessionTopology,
} from "./session-incognito-binding.js";

/** Ordinary and ordered readers capture the same selection and ancillary facts. */
export function captureSessionEntryWorkerRequest(input: SessionEntryWorkerRead) {
  const selection: SessionExactEntriesWorkerSelection = input.selection
    ? hasSessionEntrySelection(input, "session-id")
      ? { selection: { ...input.selection }, projection: input.projection }
      : hasSessionEntrySelection(input, "children")
        ? {
            selection: {
              ...input.selection,
              parentSessionKeys: [...input.selection.parentSessionKeys],
            },
            projection: input.projection,
          }
        : { selection: { ...input.selection }, projection: input.projection }
    : { sessionKeys: [...new Set(input.sessionKeys)], projection: input.projection };
  return {
    ...selection,
    expectedIdentity: input.preparedSource
      ? {
          key: `file:${input.preparedSource.databaseIdentity}` as const,
          canonicalPath: input.preparedSource.path,
          birthtime: input.preparedSource.databaseBirthtime,
        }
      : undefined,
    snapshotFields: input.snapshotFields,
    lifecycleSessionKey: input.lifecycleSessionKey,
    includeMembers: input.includeMembers,
    includeParticipantRecords: input.includeParticipantRecords,
    includeAuthorization: input.includeAuthorization,
  };
}

function hasSessionEntrySelection<Kind extends "session-id" | "children">(
  input: SessionEntryWorkerRead,
  kind: Kind,
): input is Extract<SessionEntryWorkerRead, { selection: { kind: Kind } }> {
  return input.selection?.kind === kind;
}

export function captureSessionEntryReadScope(input: SessionEntryReadScope) {
  const binding = captureIncognitoSessionBinding(input);
  const env = cloneEnvWithPlatformSemantics(
    input.env ?? (binding && captureIncognitoSessionTopology()?.env) ?? process.env,
  );
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = {
    ...input,
    env,
    ...(input.storePath ? { storePath: path.resolve(input.storePath) } : {}),
  };
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  return { scope, env, agentId };
}

export function isNativeSessionEntryRead(
  scope: SessionEntryReadScope,
  agentId: string | undefined,
) {
  const storePath = scope.storePath;
  return Boolean(
    isIncognitoSessionKey(scope.sessionKey) ||
    (storePath &&
      (isIncognitoOpenClawAgentSqlitePath(storePath, {
        agentId: agentId ?? scope.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
        env: scope.env,
      }) ||
        listOpenIncognitoAgentDatabases().some((owner) => owner.storePath === storePath))),
  );
}
