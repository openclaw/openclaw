import { toUSVString } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "../config/sessions/session-history-types.js";
import { NATIVE_HISTORY_AUTHORIZATION_REQUEST } from "../config/sessions/session-history-types.js";
import { readCronJobNamesInDatabase } from "../cron/store/job-name.kernel.js";
import { resolveCronJobsStorePath } from "../cron/store/paths.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { getUserProfileDisplays } from "../state/user-profile-list.js";
import { createCurrentUserProfileMessageProjector } from "./chat-display-projection.core.js";
import {
  projectForwardedMessages,
  readForwardedCronJobIds,
} from "./chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { projectChatHistoryWithReplies } from "./server-methods/chat-history-reply-messages.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { resolveGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

/** Dispatch only inside the history worker's admitted database lifetime. */
export async function readSessionHistoryRequest(
  request: SessionHistoryWorkerRequest,
  readTarget: PreparedSessionHistoryReadTarget,
  channel?: WorkerTaskChannel,
): Promise<SessionHistoryWorkerResult> {
  const { sourceDiscovery, ...readerTarget } = readTarget;
  const options = {
    readers: createReadonlySessionHistoryReader(
      readerTarget,
      sourceDiscovery
        ? () => resolveGatewaySessionStoreReadSources(sourceDiscovery).sources
        : undefined,
      async () => {
        if (!channel) {
          throw new Error("Native Claude history requires its host reader channel");
        }
        const response = await channel.request(NATIVE_HISTORY_AUTHORIZATION_REQUEST);
        response.consumed();
      },
    ),
    readOnly: true,
    deferProfileDisplay: true,
    resolveCronJobName: () => undefined,
  };
  if (request.kind === "active-accounting") {
    return {
      kind: "active-accounting",
      result: options.readers.readTranscriptAccounting(request.params.options),
    };
  }
  if (request.kind === "bounded-tail") {
    return {
      kind: "bounded-tail",
      result: options.readers.readBoundedMessageTail(request.params.options),
    };
  }
  if (request.kind === "summary") {
    return {
      kind: "summary",
      result: await options.readers.readSessionTranscriptSummaryAsync(
        request.params.target,
        request.params.query,
      ),
    };
  }
  if (request.kind === "artifacts") {
    const { selectSessionArtifacts } = await import("./session-artifact-read.js");
    const query = request.params.query;
    return {
      kind: "artifacts",
      result:
        query.kind === "list" && query.includeDownloadData === false && !query.downloadArtifactIds
          ? { kind: "list", artifacts: await options.readers.readArtifactSummaries(query) }
          : await selectSessionArtifacts(request.params.target, query, options.readers),
    };
  }
  if (request.kind === "message-page") {
    return {
      kind: "message-page",
      result: await options.readers.readSessionMessagesPageWithStatsAsync(
        request.params.target,
        request.params.options,
      ),
    };
  }
  if (request.kind === "around-id") {
    return {
      kind: "around-id",
      result: await options.readers.readSessionMessagesAroundIdWithStatsAsync(
        request.params.target,
        request.params.options,
      ),
    };
  }
  if (request.kind === "source-messages") {
    return {
      kind: "source-messages",
      result: await options.readers.readSessionMessagesWithSourceAsync(
        request.params.target,
        request.params.options,
      ),
    };
  }
  if (request.kind === "recent-page") {
    if (request.params.exactArchivePath) {
      const { ArchivedTranscriptReader } = await import("./session-transcript-archive-reader.js");
      return {
        kind: "recent-page",
        result: await new ArchivedTranscriptReader({
          exactArchivePath: request.params.exactArchivePath,
          sessionId: request.params.target.sessionId,
        }).readRecentWithStats(request.params.options),
      };
    }
    return {
      kind: "recent-page",
      result: await options.readers.readRecentSessionMessagesWithStatsAsync(
        request.params.target,
        request.params.options,
      ),
    };
  }
  if (request.kind === "reactions") {
    return { kind: "reactions", result: options.readers.readReactions() };
  }
  if (request.kind === "conversation-binding") {
    return {
      kind: "conversation-binding",
      result: options.readers.readConversationBinding(request.params.conversationRef),
    };
  }
  if (request.kind === "transcript-binding") {
    return {
      kind: "transcript-binding",
      binding: options.readers.readTranscriptBinding(),
    };
  }
  if (request.kind === "message-by-id") {
    const { target, messageId, options: lookupOptions } = request.params;
    return {
      kind: "message-by-id",
      result: await options.readers.readSessionMessageByIdAsync(target, messageId, lookupOptions),
    };
  }
  if (request.kind === "message-count") {
    return {
      kind: "message-count",
      count: await options.readers.readSessionMessageCountAsync(request.params.target),
    };
  }
  if (request.kind === "message-lookup") {
    return {
      kind: "message-lookup",
      messages: await options.readers.readSessionMessagesMatchingIdAsync(
        request.params.target,
        request.params.messageId,
      ),
    };
  }
  if (request.kind === "recent") {
    const { target, ...limits } = request.params;
    const { messages } = await options.readers.readRecentSessionMessagesWithStatsAsync(
      target,
      limits,
    );
    return { kind: "recent", messages };
  }
  if (request.kind === "delta") {
    const { prepareSessionHistoryDelta } = await import("./session-history-delta-visibility.js");
    return {
      kind: "delta",
      ...prepareSessionHistoryDelta(
        options.readers.readTranscriptDisplayDelta(request.params.limits),
        options.readers.subagentCoordination,
      ),
    };
  }
  if (request.kind === "inline-visibility") {
    const { prepareSessionHistorySubagentFacts } =
      await import("./session-history-delta-visibility.js");
    const { lookup } = request.params;
    return {
      kind: "inline-visibility",
      subagentCoordination: prepareSessionHistorySubagentFacts(
        options.readers.subagentCoordination,
        (recording) =>
          lookup.kind === "session"
            ? recording.isSubagentSession(lookup.sessionKey)
            : recording.isSubagentRunMessage(lookup.runId, lookup.messageSeq),
      ),
    };
  }
  if (request.kind === "rpc-message") {
    const { readChatHistoryMessageFromReaders } = await import("./cli-session-history.js");
    return {
      kind: "rpc-message",
      result: await readChatHistoryMessageFromReaders(request.params, options.readers),
    };
  }
  if (request.kind === "rpc") {
    const { readChatHistoryPageKernel } =
      await import("./server-methods/chat-history-page-kernel.js");
    const { encodeChatHistoryResponsePage } =
      await import("./server-methods/chat-history-response-page.js");
    const cli = getCliSessionBinding(request.params.entry, "claude-cli")?.sessionId
      ? await (
          await import("./cli-session-history.js")
        ).prepareCliSessionHistoryReader(request.params, options.readers)
      : undefined;
    try {
      const page = await readChatHistoryPageKernel(request.params, {
        ...options,
        ...(cli ? { readers: cli.readers, readMessageSequence: cli.sequence } : {}),
      });
      cli?.applyPagination(page);
      const messages = page.messages.filter(
        (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
      );
      page.messages = await projectChatHistoryWithReplies(messages, (displayMessages) => {
        const profileIds = displayMessages.flatMap((message) => {
          const identity = readTranscriptSenderIdentity(
            asOptionalRecord(message["__openclaw"])?.senderIdentity,
          );
          return message.role === "user" && identity?.type === "profile" ? [identity.id] : [];
        });
        const { path, environment: env } = expectDefined(
          readTarget.stateDatabase,
          "RPC history requires its captured shared-state owner",
        );
        const state = { path, env };
        const jobIds = [...new Set(readForwardedCronJobIds(displayMessages).map(toUSVString))];
        const names = jobIds.length
          ? withExistingOpenClawStateDatabaseReadOnly(
              ({ db }) =>
                readCronJobNamesInDatabase(db, jobIds, resolveCronJobsStorePath(undefined, env)),
              state,
            )
          : undefined;
        let profiles: ReturnType<typeof getUserProfileDisplays> | undefined;
        const project = createCurrentUserProfileMessageProjector((id) =>
          resolveCurrentUserProfileDisplay(id, (senderId) =>
            (profiles ??= getUserProfileDisplays(profileIds, state)).get(senderId),
          ),
        );
        return projectForwardedMessages(displayMessages, (jobId) =>
          names?.get(toUSVString(jobId)),
        ).map(project);
      });
      return {
        kind: "rpc",
        page: encodeChatHistoryResponsePage(page, request.params),
      };
    } finally {
      cli?.dispose();
    }
  }
  const { readSessionHistorySnapshotKernel } = await import("./session-history-snapshot.js");
  return {
    kind: "http",
    snapshot: await readSessionHistorySnapshotKernel(request.params, options),
  };
}
