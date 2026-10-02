import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";

const GITHUB_PUBLICATION_RESPONSE_PREFIX = "github-publication:";

/** A proven replacement is terminal for this notification, not a storage retry. */
export class GitHubPublicationReviewGenerationChangedError extends Error {
  constructor() {
    super("GitHub publication review transcript generation changed");
  }
}

function formatGitHubPublicationResult(result: SessionGitHubPublicationResult): string {
  const publisher = result.publisher;
  const source =
    publisher?.source === "personal"
      ? "My GitHub"
      : publisher?.source === "agent-override"
        ? "Agent override"
        : "System";
  const acting = publisher ? ` Using @${publisher.login} (${source}).` : "";
  switch (result.status) {
    case "published":
      return `Published ${result.repository} branch ${result.branch}: ${result.url}${acting}`;
    case "failed":
      return `GitHub publication failed: ${result.message} ${result.nextAction}${acting}`;
    case "publishing":
    case "requested":
    case "needs_confirmation":
      return `${result.message}${acting}`;
  }
  return result satisfies never;
}

export function createGitHubPublicationTranscriptReporter(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetWithStore: typeof import("./session-utils.js").resolveGatewaySessionStoreTargetWithStore;
  }>,
  coordinator: Pick<GitHubPublicationCoordinator, "markReported">,
) {
  return async (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    lifecycleRevision?: string | null;
    result: SessionGitHubPublicationResult;
  }): Promise<void> => {
    const runtime = await loadSessionRuntime();
    const target = runtime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: params.sessionKey,
      agentId: params.agentId,
      clone: false,
    });
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
    if (
      (params.lifecycleRevision === undefined && entry?.sessionId !== params.sessionId) ||
      target.canonicalKey !== params.sessionKey
    ) {
      throw new Error("GitHub publication transcript owner changed");
    }
    const scope = {
      agentId: target.agentId,
      sessionId: params.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    };
    let sessionEntryCurrent: SessionEntryCurrentCheck | undefined;
    if (params.lifecycleRevision !== undefined) {
      const assertCurrent = (facts: SessionEntryCurrentFacts | undefined) => {
        if (!facts) {
          throw new Error("GitHub publication review transcript owner is unavailable");
        }
        if (
          facts.sessionId !== params.sessionId ||
          (facts.lifecycleRevision ?? null) !== params.lifecycleRevision
        ) {
          throw new GitHubPublicationReviewGenerationChangedError();
        }
      };
      sessionEntryCurrent = await withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          assertCurrent(read.value);
          const captured = captureSessionEntryCurrentRead(scope, owner);
          if (captured.kind !== "file") {
            throw new Error("Publication review reporting requires its durable session owner");
          }
          return {
            source: captured.source,
            assertCurrent: (facts) => {
              captured.assertSourceCurrent();
              assertCurrent(facts);
            },
          };
        },
      );
    }
    const appended = await appendSessionTranscriptReport(
      scope,
      {
        kind: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: formatGitHubPublicationResult(params.result) }],
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-publication",
          responseId: `${GITHUB_PUBLICATION_RESPONSE_PREFIX}${params.result.requestId}`,
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
      },
      sessionEntryCurrent ? { sessionEntryCurrent } : undefined,
    );
    if (!appended.ok) {
      throw new Error("GitHub publication transcript owner changed", { cause: appended.error });
    }
    await coordinator.markReported(params.result.requestId);
  };
}
