import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import { captureIncognitoSessionOperation } from "../config/sessions/session-incognito-binding.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";

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
      return `GitHub publication failed: ${result.message} ${result.nextAction}${acting}`;
    case "publishing":
    case "requested":
    case "needs_confirmation":
      return `${result.message}${acting}`;
  }
  return result satisfies never;
}

export async function reportGitHubPublicationTranscript(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetWithStore: typeof import("./session-utils.js").resolveGatewaySessionStoreTargetWithStore;
  }>,
  coordinator: Pick<GitHubPublicationCoordinator, "markReportedAsync">,
  params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    result: SessionGitHubPublicationResult;
  },
): Promise<void> {
  const incognito = captureIncognitoSessionOperation(params);
  const claim = incognito?.actor.sessions.captureCurrent(params.sessionKey);
  const selected = incognito
    ? {
        target: {
          agentId: incognito.actor.agentId,
          canonicalKey: params.sessionKey,
          storePath: incognito.actor.path,
        },
        entry: incognito.actor.sessions.readSharing(params.sessionKey)?.entry,
      }
    : await (async () => {
        const runtime = await loadSessionRuntime();
        const target = runtime.resolveGatewaySessionStoreTargetWithStore({
          cfg: getRuntimeConfig(),
          key: params.sessionKey,
          agentId: params.agentId,
          clone: false,
        });
        return {
          target,
          entry: runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
        };
      })();
  const { target, entry } = selected;
  if (entry?.sessionId !== params.sessionId || target.canonicalKey !== params.sessionKey) {
    throw new Error("GitHub publication transcript owner changed");
  }
  const appended = await appendSessionTranscriptReport(
    {
      agentId: target.agentId,
      sessionId: params.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
      ...(incognito && { expectedLifecycleRevision: entry.lifecycleRevision }),
    },
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
    incognito && {
      incognito: {
        actor: incognito.actor,
        authority: {
          assertCurrent() {
            incognito.authority.assertCurrent();
            claim!.assertCurrent();
          },
        },
      },
    },
  );
  if (!appended.ok) {
    throw new Error("GitHub publication transcript owner changed", { cause: appended.error });
  }
  claim?.assertCurrent();
  await coordinator.markReportedAsync(params.result.requestId);
}
