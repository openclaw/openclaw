import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { isSessionControllerWorkActive } from "../sessions/session-controller.lifecycle-observation.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import {
  AUTOMATION_RESULT_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
} from "../shared/transcript-only-openclaw-assistant.js";
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
        ? "Own account"
        : "Shared agent account";
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
  const sourceLifecycle = await coordinator.readReportLifecycleAsync(params);
  if (params.origin && params.origin.agentId !== params.agentId) {
    throw new Error("GitHub publication transcript origin is invalid.");
  }
  const recipient = params.origin ?? params;
  const lifecycleRevision = params.origin ? params.origin.lifecycleRevision : sourceLifecycle;
  const memory = captureSessionActorStorageOwner(recipient, {
    assertCurrent() {},
    authorize() {},
  });
  const selected = memory
    ? {
        target: {
          agentId: memory.agentId,
          canonicalKey: recipient.sessionKey,
          storePath: memory.path,
        },
        entry: readCapturedSessionActorEntry(memory, recipient.sessionKey),
      }
    : await (async () => {
        const runtime = await loadSessionRuntime();
        const target = await runtime.resolveGatewaySessionStoreTargetInWorker({
          cfg: getRuntimeConfig(),
          key: recipient.sessionKey,
          agentId: recipient.agentId,
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
    target.canonicalKey === recipient.sessionKey &&
    (entry.sessionId !== recipient.sessionId ||
      (entry.lifecycleRevision ?? null) !== lifecycleRevision)
  ) {
    await coordinator.markReportedAsync(params.result.requestId);
    return;
  }
  if (entry?.sessionId !== recipient.sessionId || target.canonicalKey !== recipient.sessionKey) {
    throw new Error("GitHub publication transcript owner changed");
  }
  // A receipt that lands inside a live run would sit before that run's later messages on
  // replay. Use the pending background-result row, so the run's next request appends it.
  const placement = isSessionControllerWorkActive(
    target.storePath,
    [recipient.sessionKey, recipient.sessionId],
    target.agentId,
  )
    ? {
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        model: AUTOMATION_RESULT_MODEL,
        excludeFromContext: true,
        openclawModelPlacement: "pending" as const,
      }
    : {};
  const appended = await appendSessionTranscriptReport(
    {
      agentId: target.agentId,
      sessionId: recipient.sessionId,
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
          ...placement,
        },
        params.origin?.runId ?? params.runId,
      ),
    },
  );
  if (!appended.ok) {
    throw new Error("GitHub publication transcript owner changed", { cause: appended.error });
  }
  await coordinator.markReportedAsync(params.result.requestId);
}
