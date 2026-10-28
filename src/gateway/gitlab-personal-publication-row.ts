import { Value } from "typebox/value";
import { z } from "zod";
import {
  SessionGitLabPublicationResultSchema,
  type SessionGitLabPublicationResult,
} from "../../packages/gateway-protocol/src/schema/gitlab.js";
import type { PersonalForgePublicationActionV2 } from "./forge-personal-publication-custody.js";
import {
  managedGitLabPublicationGeneration,
  publicationPublisher,
  sameGitLabPublicationPublisher,
  type GitLabPublicationCredential,
} from "./gitlab-personal-publication-identity.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "./gitlab-personal-publication-store.js";

const targetSchema = z.strictObject({
  issuer: z.string(),
  projectId: z.number().int().positive(),
  projectPath: z.string(),
  gitUrl: z.string(),
  webUrl: z.string(),
  baseBranch: z.string(),
});
const oid = z.string().regex(/^[a-f0-9]{40}$/u);
export const gitLabPublicationReceiptSchema = z.object({
  target: targetSchema,
  sessionIdentity: z.object({
    sessionId: z.string(),
    sessionKey: z.string(),
    agentId: z.string(),
    lifecycleRevision: z.string().nullable(),
  }),
  sourceId: z.string(),
  worktreeId: z.string(),
  repositoryRoot: z.string(),
  repositoryFingerprint: z.string(),
  actor: z.object({ accountId: z.number().int().positive(), login: z.string() }),
  publisher: z
    .discriminatedUnion("source", [
      z.strictObject({ source: z.literal("personal") }),
      z.strictObject({
        source: z.enum(["system-configured", "agent-override"]),
        profileId: z.string().regex(/^glp_[a-f0-9]{32}$/u),
        recordCreatedAtMs: z.number().int().nonnegative().safe(),
      }),
    ])
    .optional(),
  title: z.string(),
  description: z.string(),
  draft: z.boolean(),
  bootstrapDraft: z.boolean().optional(),
  sourceHead: oid,
  baseTree: oid,
  workspaceHead: oid,
  sourceIndexTree: oid,
  branch: z.string(),
  createdAtMs: z.number(),
  previousHeadCommit: oid.nullable(),
  publicationParentCommit: oid.optional(),
});
export type AcceptedGitLabPublication = z.infer<typeof gitLabPublicationReceiptSchema>;

export function readAcceptedGitLabPublication(row: PersonalGitLabPublicationRow) {
  const saved = gitLabPublicationReceiptSchema.parse(JSON.parse(row.receipt_json));
  const publisher = publicationPublisher(saved.publisher);
  if (
    (saved.bootstrapDraft &&
      (!saved.draft ||
        saved.previousHeadCommit !== null ||
        saved.workspaceHead !== saved.baseTree)) ||
    row.request_digest !== personalGitLabRequestDigest(row) ||
    row.issuer !== saved.target.issuer ||
    row.identity_account_id !== saved.actor.accountId ||
    row.identity_login !== saved.actor.login ||
    row.session_id !== saved.sessionIdentity.sessionId ||
    row.session_key !== saved.sessionIdentity.sessionKey ||
    row.agent_id !== saved.sessionIdentity.agentId ||
    row.session_lifecycle_revision !== saved.sessionIdentity.lifecycleRevision ||
    row.worktree_id !== saved.worktreeId ||
    row.repository_fingerprint !== saved.repositoryFingerprint ||
    row.branch !== saved.branch ||
    row.created_at_ms !== saved.createdAtMs ||
    (publisher.source !== "personal" &&
      row.connection_generation !==
        managedGitLabPublicationGeneration({
          publisher,
          issuer: row.issuer,
          accountId: row.identity_account_id,
          login: row.identity_login,
        }))
  ) {
    throw new Error("The accepted GitLab publication receipt is inconsistent.");
  }
  return saved;
}

export function createPersonalGitLabPublicationRow(params: {
  action: PersonalForgePublicationActionV2;
  credential: GitLabPublicationCredential;
  requestId: string;
  idempotencyKey: string;
  saved: AcceptedGitLabPublication;
}): PersonalGitLabPublicationRow {
  const { action, credential, saved } = params;
  if (!sameGitLabPublicationPublisher(saved.publisher, credential.publisher)) {
    throw new Error("GitLab publication source changed before acceptance.");
  }
  const row: PersonalGitLabPublicationRow = {
    request_id: params.requestId,
    owner_profile_id: action.owner,
    issuer: saved.target.issuer,
    connection_generation: credential.generation,
    idempotency_key: params.idempotencyKey,
    request_digest: "",
    session_id: action.sessionId,
    session_key: action.sessionKey,
    agent_id: action.agentId,
    session_lifecycle_revision: action.lifecycleRevision,
    worktree_id: saved.worktreeId,
    repository_fingerprint: saved.repositoryFingerprint,
    identity_account_id: credential.account.accountId,
    identity_login: credential.account.login,
    branch: saved.branch,
    receipt_json: JSON.stringify(saved),
    status: "requested",
    gateway_instance_id: null,
    execution_id: null,
    head_commit: null,
    pull_request_url: null,
    error_code: null,
    next_action: null,
    last_effect: null,
    effect_state: null,
    push_observation: null,
    result_json: null,
    created_at_ms: saved.createdAtMs,
    updated_at_ms: saved.createdAtMs,
    reported_at_ms: null,
  };
  row.request_digest = personalGitLabRequestDigest(row);
  return row;
}

export function projectPersonalGitLabTerminalResult(
  row: PersonalGitLabPublicationRow,
): SessionGitLabPublicationResult {
  const saved = readAcceptedGitLabPublication(row);
  const publisher = {
    source: publicationPublisher(saved.publisher).source,
    accountId: row.identity_account_id,
    login: row.identity_login,
  };
  const result = z
    .discriminatedUnion("status", [
      z.object({
        status: z.literal("published"),
        requestId: z.string(),
        url: z.string(),
        repository: z.string(),
        branch: z.string(),
        headCommit: z.string(),
      }),
      z.object({
        status: z.literal("failed"),
        code: z.string(),
        requestId: z.string(),
        message: z.string(),
        nextAction: z.string(),
      }),
    ])
    .parse(row.result_json ? JSON.parse(row.result_json) : null);
  if (
    result.status !== row.status ||
    result.requestId !== row.request_id ||
    (result.status === "published" &&
      (result.headCommit !== row.head_commit || result.url !== row.pull_request_url)) ||
    (result.status === "failed" &&
      (result.code !== row.error_code || result.nextAction !== row.next_action))
  ) {
    throw new Error("The terminal GitLab publication receipt is inconsistent.");
  }
  const projected = { ...result, publisher };
  if (!Value.Check(SessionGitLabPublicationResultSchema, projected)) {
    throw new Error("The GitLab publication result is invalid.");
  }
  return projected;
}
