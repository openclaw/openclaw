import type {
  SessionGitHubPublicationResult,
  SessionGitHubReadinessResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { preparePublishingSession } from "./github-publication-action-target.js";
import { qualifyGitHubPublicationSource } from "./github-publication-availability.js";
import {
  GitHubPublicationSessionChangedError,
  GitHubPublicationWorkspaceChangedError,
} from "./github-publication-failure.js";
import { prepareGitHubPublicationOptionsRead } from "./server-methods/github-personal-authorization.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

/** Receipt text and account/confirmation fields are not readiness facts. */
function observeReceipt(result: SessionGitHubPublicationResult) {
  const base = { requestId: result.requestId, ...(result.effect ? { effect: result.effect } : {}) };
  switch (result.status) {
    case "requested":
    case "publishing":
      return { ...base, status: result.status };
    case "published":
      return {
        ...base,
        status: result.status,
        url: result.url,
        repository: result.repository,
        branch: result.branch,
        headCommit: result.headCommit,
      };
    case "failed":
      return { ...base, status: result.status, code: result.code };
    case "needs_confirmation":
      throw new Error("Personal confirmation is not a shared observation.");
    default: {
      const unexpected: never = result;
      throw new Error("Unknown publication receipt status", { cause: unexpected });
    }
  }
}

export async function readGitHubPublicationReadiness(
  options: GatewayRequestHandlerOptions,
  params: { sessionKey: string; agentId?: string; requestId?: string },
  signal: AbortSignal,
): Promise<SessionGitHubReadinessResult> {
  return withArtifactPreservingStateReads(
    async () => {
      using read = await prepareGitHubPublicationOptionsRead(
        options,
        params,
        signal,
        "shared-observation",
      );
      const session = read.currentSession();
      const assertCurrent = () => read.assertSessionUnchanged(session);
      using lineage = new DisposableStack();
      const caller = getGatewayToolCallerIdentity();
      const selected =
        caller && (caller.sessionKey !== session.sessionKey || caller.agentId !== session.agentId)
          ? await preparePublishingSession(
              {
                sessionKey: caller.sessionKey,
                agentId: caller.agentId,
                publishingSessionKey: session.sessionKey,
              },
              assertCurrent,
              lineage,
            )
          : undefined;
      const assertAuthority = () => {
        assertCurrent();
        selected?.assertCurrent();
      };
      const service = options.context.githubPublicationService;
      const observeRequest = async (): Promise<SessionGitHubReadinessResult["request"]> => {
        try {
          if (!service) {
            throw new Error("Publication observation is unavailable.");
          }
          const receipt = params.requestId
            ? await service.sharedStatus(session, params.requestId)
            : await service.latestShared(session, undefined, undefined, read.currentSessionRead);
          assertAuthority();
          return receipt
            ? {
                kind: "observed",
                selection: params.requestId ? "exact" : "current",
                receipt: observeReceipt(receipt.result),
              }
            : params.requestId
              ? { kind: "unknown", reason: "not-observable", selectedRequestId: params.requestId }
              : { kind: "none", selection: "current" };
        } catch {
          assertAuthority();
          return {
            kind: "unknown",
            reason: "unavailable",
            ...(params.requestId ? { selectedRequestId: params.requestId } : {}),
          };
        }
      };
      const [source, request] = await Promise.all([
        qualifyGitHubPublicationSource(session, assertAuthority, read.currentSessionRead, {
          readMode: "existing-only",
        }),
        observeRequest(),
      ]);
      assertAuthority();
      const unavailable = (
        cause: unknown,
      ): Pick<SessionGitHubReadinessResult, "custody" | "target"> => ({
        custody:
          cause instanceof GitHubPublicationSessionChangedError ||
          cause instanceof GitHubPublicationWorkspaceChangedError
            ? { kind: "changed" }
            : { kind: "unknown", reason: "unavailable" },
        target: { kind: "unknown", reason: "unavailable" },
      });
      let observation: Pick<SessionGitHubReadinessResult, "custody" | "target">;
      if (source.ok) {
        try {
          source.assertCurrent();
          observation = { custody: source.custody, target: source.target };
        } catch (cause) {
          assertAuthority();
          observation = unavailable(cause);
        }
      } else {
        observation = unavailable(source.cause);
      }
      const remedies: SessionGitHubReadinessResult["remedies"] = [];
      if (observation.custody.kind === "unbound_workspace") {
        remedies.push({ kind: "select_bound_session" });
      } else if (
        observation.custody.kind === "changed" ||
        observation.custody.kind === "archived" ||
        observation.target.kind === "unsupported"
      ) {
        remedies.push({ kind: "inspect_source" });
      }
      if (
        request.kind === "observed" &&
        (request.receipt.status === "requested" || request.receipt.status === "publishing")
      ) {
        remedies.push({ kind: "observe_request", requestId: request.receipt.requestId });
      } else if (request.kind === "unknown" && request.selectedRequestId) {
        remedies.push({ kind: "observe_request", requestId: request.selectedRequestId });
      }
      if (observation.custody.kind === "unknown" || request.kind === "unknown") {
        remedies.push({ kind: "retry_read" });
      }
      assertAuthority();
      return { policy: { read: "admitted", write: "unknown" }, ...observation, request, remedies };
    },
    { agentDatabases: true },
  );
}
