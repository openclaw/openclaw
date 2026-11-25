// Read-only projection of the legacy migration owner's captured source and canonical policy.
import { isDeepStrictEqual } from "node:util";
import { root } from "@openclaw/fs-safe";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import {
  normalizeExecApprovalsInternal,
  resolveExecApprovalsPath,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { readExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import { pathMayExistSync } from "./path-existence.js";
import {
  DOCTOR_CLAIM_SUFFIX,
  MAX_LEGACY_EXEC_APPROVALS_BYTES,
  readLegacyExecApprovalsSourceSnapshot,
} from "./state-migrations.exec-approvals.js";
const TARGET_TABLE = "exec_approvals_config";

function comparableExecApprovalsPolicy(input: ExecApprovalsFile) {
  const file = normalizeExecApprovalsInternal(input);
  return {
    ...file,
    socket: undefined,
    agents: Object.fromEntries(
      Object.entries(file.agents ?? {}).map(([name, agent]) => [
        name,
        {
          security: agent.security,
          ask: agent.ask,
          askFallback: agent.askFallback,
          autoAllowSkills: agent.autoAllowSkills,
          // Generated identity and observed use explain a rule; they do not change its authority.
          allowlist: agent.allowlist?.map((entry) => ({
            pattern: entry.pattern,
            source: entry.source,
            commandText: entry.commandText,
            argPattern: entry.argPattern,
          })),
          mcpTools: agent.mcpTools?.map((entry) => ({
            server: entry.server,
            tool: entry.tool,
            source: entry.source,
          })),
        },
      ]),
    ),
  };
}

/** Show policy differences without revealing socket credentials or command patterns. */
export async function inspectLegacyExecApprovals(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = resolveExecApprovalsPath(env);
  const claimedPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const retainedPath = pathMayExistSync(sourcePath) ? sourcePath : claimedPath;
  if (!pathMayExistSync(retainedPath)) {
    return { sourcePath, pending: false as const };
  }
  const stateRoot = await root(params.stateDir, {
    hardlinks: "reject",
    maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
    symlinks: "reject",
  });
  const snapshot = await readLegacyExecApprovalsSourceSnapshot(
    stateRoot,
    params.stateDir,
    retainedPath,
  );
  const legacy = snapshot.legacy.ok ? snapshot.legacy.value : null;
  const row = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => (tableExists(db, TARGET_TABLE) ? readExecApprovalsConfigRow(db) : undefined),
    { env },
  );
  const canonical = row ? tryParsePersistedExecApprovals(row.raw_json) : null;
  const credentials = runClientCredentialOperation(
    env,
    { kind: "socket.read" },
    { readOnly: true },
  );
  const socket = credentials.kind === "socket" ? credentials.socket : null;
  const summarize = (file: ExecApprovalsFile | null) =>
    file
      ? {
          valid: true,
          defaults: {
            security: file.defaults?.security,
            ask: file.defaults?.ask,
            askFallback: file.defaults?.askFallback,
            autoAllowSkills: file.defaults?.autoAllowSkills,
          },
          agentCount: Object.keys(file.agents ?? {}).length,
          allowlistCount: Object.values(file.agents ?? {}).reduce(
            (count, agent) => count + (agent.allowlist?.length ?? 0),
            0,
          ),
        }
      : { valid: false };
  return {
    sourcePath: retainedPath,
    pending: true as const,
    legacy: summarize(legacy),
    current: summarize(canonical),
    policyMatches: Boolean(
      legacy &&
      canonical &&
      isDeepStrictEqual(
        comparableExecApprovalsPolicy(legacy),
        comparableExecApprovalsPolicy(canonical),
      ),
    ),
    socketMatches: Boolean(
      legacy &&
      canonical &&
      legacy.socket?.path === (socket?.socket_path ?? undefined) &&
      legacy.socket?.token === (socket?.socket_token ?? undefined),
    ),
  };
}
