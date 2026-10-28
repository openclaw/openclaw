import type { SessionGitLabPublicationResult } from "../../packages/gateway-protocol/src/schema/gitlab.js";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import type {
  GitHubPublicationCoordinator,
  GitHubPublicationTranscriptReport,
} from "./github-publication.js";

const GITHUB_PUBLICATION_RESPONSE_PREFIX = "github-publication:";
const GITLAB_PUBLICATION_RESPONSE_PREFIX = "gitlab-publication:";

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

function formatGitLabPublicationResult(result: SessionGitLabPublicationResult): string {
  const publisher = result.publisher;
  const source =
    publisher?.source === "personal"
      ? "My GitLab"
      : publisher?.source === "agent-override"
        ? "Agent override"
        : "System GitLab";
  const acting = publisher ? ` Using @${publisher.login} (${source}).` : "";
  switch (result.status) {
    case "published":
      return `Published ${result.repository} branch ${result.branch}: ${result.url}${acting}`;
    case "failed":
      return `GitLab publication failed: ${result.message} ${result.nextAction}${acting}`;
    case "publishing":
    case "requested":
    case "needs_confirmation":
      return `${result.message}${acting}`;
  }
  return result satisfies never;
}

export type GitLabPublicationTranscriptReport = Omit<
  GitHubPublicationTranscriptReport,
  "result"
> & {
  result: SessionGitLabPublicationResult;
};

type TranscriptReport = GitHubPublicationTranscriptReport | GitLabPublicationTranscriptReport;
type TranscriptOwner = {
  markReportedAsync: (requestId: string) => Promise<void>;
};

async function reportPublicationTranscript(
  loadSessionRuntime: Parameters<typeof reportGitHubPublicationTranscript>[0],
  coordinator: TranscriptOwner,
  params: TranscriptReport,
  provider: {
    responsePrefix: string;
    ownerChanged: string;
    text: string;
  },
): Promise<void> {
  const result = params.result;
  const responseId = `${provider.responsePrefix}${result.requestId}`;
  const memory = captureSessionActorStorageOwner(params, {
    assertCurrent() {},
    authorize() {},
  });
  const selected = memory
    ? {
        target: {
          agentId: memory.agentId,
          canonicalKey: params.sessionKey,
          storePath: memory.path,
        },
        entry: readCapturedSessionActorEntry(memory, params.sessionKey),
      }
    : await (async () => {
        const runtime = await loadSessionRuntime();
        const target = await runtime.resolveGatewaySessionStoreTargetInWorker({
          cfg: getRuntimeConfig(),
          key: params.sessionKey,
          agentId: params.agentId,
        });
        return {
          target,
          entry: runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
        };
      })();
  const { target, entry } = selected;
  if (entry?.sessionId !== params.sessionId || target.canonicalKey !== params.sessionKey) {
    throw new Error(provider.ownerChanged);
  }
  const appended = await appendSessionTranscriptReport(
    {
      agentId: target.agentId,
      sessionId: params.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    },
    {
      kind: "assistant",
      message: attachSessionTranscriptRunId(
        {
          role: "assistant",
          content: [{ type: "text", text: provider.text }],
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-publication",
          responseId,
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
        params.runId,
      ),
    },
  );
  if (!appended.ok) {
    throw new Error(provider.ownerChanged, { cause: appended.error });
  }
  await coordinator.markReportedAsync(result.requestId);
}

export async function reportGitHubPublicationTranscript(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetInWorker: typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker;
  }>,
  coordinator: Pick<GitHubPublicationCoordinator, "markReportedAsync">,
  params: GitHubPublicationTranscriptReport,
): Promise<void> {
  await reportPublicationTranscript(loadSessionRuntime, coordinator, params, {
    responsePrefix: GITHUB_PUBLICATION_RESPONSE_PREFIX,
    ownerChanged: "GitHub publication transcript owner changed",
    text: formatGitHubPublicationResult(params.result),
  });
}

export async function reportGitLabPublicationTranscript(
  loadSessionRuntime: Parameters<typeof reportGitHubPublicationTranscript>[0],
  coordinator: TranscriptOwner,
  params: GitLabPublicationTranscriptReport,
): Promise<void> {
  await reportPublicationTranscript(loadSessionRuntime, coordinator, params, {
    responsePrefix: GITLAB_PUBLICATION_RESPONSE_PREFIX,
    ownerChanged: "GitLab publication transcript owner changed",
    text: formatGitLabPublicationResult(params.result),
  });
}
