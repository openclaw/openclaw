import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { ensureGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  WorkerOperationContext,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  insertPersonalGitHubPublicationInDatabase,
  type PersonalGitHubPublicationRow,
} from "./github-personal-publication-store.js";
import type {
  GitHubPublicationReviewBinding,
  SharedGitHubPublicationAdmission,
} from "./github-publication-admission.js";
import {
  bindGitHubPublicationReviewInDatabase,
  publicationCommit,
  transactGitHubPublication,
} from "./github-publication-review-store.worker.js";
import {
  assertStoredGitHubPublicationClaim,
  insertGitHubPublicationRequestInDatabase,
  readGitHubPublicationRequest,
  sameGitHubPublicationClaim,
} from "./github-publication-store.js";
import {
  insertRepositoryGitHubPublicationInDatabase,
  readRepositoryGitHubPublicationInDatabase,
} from "./github-repository-publication-store.js";

export const publicationAdmissionOperations = {
  "publicationAdmission.shared": (
    input: { request: SharedGitHubPublicationAdmission; review?: GitHubPublicationReviewBinding },
    context: WorkerOperationContext,
  ) =>
    transactGitHubPublication(context, (db) => {
      ensureGitHubPublicationSchema(db);
      const request = input.request;
      const previous = readGitHubPublicationRequest(db, {
        sessionId: request.sessionId,
        idempotencyKey: request.request.idempotencyKey,
      });
      const assertClaim = () => {
        if (request.claim) {
          assertStoredGitHubPublicationClaim(db, { claim: request.claim, ...request.request });
        }
      };
      assertClaim();
      const row = insertGitHubPublicationRequestInDatabase(db, request);
      assertClaim();
      const bound = input.review
        ? bindGitHubPublicationReviewInDatabase(
            db,
            input.review,
            {
              sessionId: request.sessionId,
              sessionKey: request.request.sessionKey,
              agentId: request.request.agentId,
              lifecycleRevision: request.lifecycleRevision,
            },
            row.request_id,
          )
        : undefined;
      if (request.claim && !sameGitHubPublicationClaim(row, request.claim)) {
        throw new Error("GitHub publication idempotency key was reused.");
      }
      const result = publicationCommit(row, bound ? [bound.row] : [], bound?.changed);
      if (!previous) {
        result.sessions.push({ sessionKey: row.session_key, agentId: row.agent_id });
      }
      return result;
    }),
  "publicationAdmission.personal": (
    input: {
      row: PersonalGitHubPublicationRow;
      lifecycleRevision: string | null;
      review?: GitHubPublicationReviewBinding;
    },
    context: WorkerOperationContext,
  ) =>
    transactGitHubPublication(context, (db) => {
      const row = insertPersonalGitHubPublicationInDatabase(db, input.row, input.lifecycleRevision);
      const bound = input.review
        ? bindGitHubPublicationReviewInDatabase(
            db,
            input.review,
            {
              sessionId: input.row.session_id,
              sessionKey: input.row.session_key,
              agentId: input.row.agent_id,
              lifecycleRevision: input.lifecycleRevision,
            },
            row.request_id,
          )
        : undefined;
      return publicationCommit(row, bound ? [bound.row] : [], bound?.changed);
    }),
  "publicationAdmission.repository": (
    input: { row: RepositoryGitHubPublicationRow; review?: GitHubPublicationReviewBinding },
    context: WorkerOperationContext,
  ) =>
    transactGitHubPublication(context, (db) => {
      const previous = tableExists(db, "github_repository_publication_requests")
        ? readRepositoryGitHubPublicationInDatabase(db, input.row.request_id)
        : undefined;
      const row = insertRepositoryGitHubPublicationInDatabase(db, input.row);
      const bound = input.review
        ? bindGitHubPublicationReviewInDatabase(
            db,
            input.review,
            {
              sessionId: input.row.session_id,
              sessionKey: input.row.session_key,
              agentId: input.row.agent_id,
              lifecycleRevision: input.row.session_lifecycle_revision,
            },
            row.request_id,
          )
        : undefined;
      const result = publicationCommit(row, bound ? [bound.row] : [], bound?.changed);
      if (!previous && row.request_id === input.row.request_id && row.owner_profile_id === null) {
        result.sessions.push({ sessionKey: row.session_key, agentId: row.agent_id });
      }
      return result;
    }),
};
export type PublicationAdmissionWorkerOperations = WorkerOperations<
  typeof publicationAdmissionOperations
>;
