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
import type { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import type { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils.js";

const GITHUB_PUBLICATION_RESPONSE_PREFIX = "github-publication:";

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
      return `${result.message} ${result.nextAction}${acting}`;
    case "publishing":
    case "requested":
    case "needs_confirmation":
      return `${result.message}${acting}`;
  }
  return result satisfies never;
}

export async function reportGitHubPublicationTranscript(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetInWorker: typeof resolveGatewaySessionStoreTargetInWorker;
  }>,
  coordinator: Pick<GitHubPublicationCoordinator, "markReportedAsync" | "readReportLifecycleAsync">,
  params: GitHubPublicationTranscriptReport,
): Promise<void> {
  const lifecycleRevision = await coordinator.readReportLifecycleAsync(params);
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
  // A reset or rotation ended that transcript for good; the receipt stays readable by request id.
  if (
    entry &&
    target.canonicalKey === params.sessionKey &&
    (entry.sessionId !== params.sessionId ||
      (entry.lifecycleRevision ?? null) !== lifecycleRevision)
  ) {
    await coordinator.markReportedAsync(params.result.requestId);
    return;
  }
  if (entry?.sessionId !== params.sessionId || target.canonicalKey !== params.sessionKey) {
    throw new Error("GitHub publication transcript owner changed");
  }
  const appended = await appendSessionTranscriptReport(
    {
      agentId: target.agentId,
      sessionId: params.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
      expectedLifecycleRevision: lifecycleRevision ?? undefined,
    },
    {
      kind: "assistant",
      message: attachSessionTranscriptRunId(
        {
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
        params.runId,
      ),
    },
  );
  if (!appended.ok) {
    throw new Error("GitHub publication transcript owner changed", { cause: appended.error });
  }
  await coordinator.markReportedAsync(params.result.requestId);
}
