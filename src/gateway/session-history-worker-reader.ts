import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "../config/sessions/session-history-types.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { resolveGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

/** Dispatch only inside the history worker's admitted database lifetime. */
export async function readSessionHistoryRequest(
  request: SessionHistoryWorkerRequest,
  readTarget: PreparedSessionHistoryReadTarget,
): Promise<SessionHistoryWorkerResult> {
  const { sourceDiscovery, ...readerTarget } = readTarget;
  const options = {
    readers: createReadonlySessionHistoryReader(
      readerTarget,
      sourceDiscovery
        ? () => resolveGatewaySessionStoreReadSources(sourceDiscovery).sources
        : undefined,
    ),
    readOnly: true,
    deferProfileDisplay: true,
    resolveCronJobName: () => undefined,
  };
  if (request.kind === "artifacts") {
    const { selectSessionArtifacts } = await import("./session-artifact-read.js");
    return {
      kind: "artifacts",
      result: await selectSessionArtifacts(
        request.params.target,
        request.params.query,
        options.readers,
      ),
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
    return {
      kind: "recent-page",
      result: await options.readers.readRecentSessionMessagesWithStatsAsync(
        request.params.target,
        request.params.options,
      ),
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
  if (request.kind === "rpc") {
    const { readChatHistoryPageKernel } =
      await import("./server-methods/chat-history-page-kernel.js");
    return {
      kind: "rpc",
      page: await readChatHistoryPageKernel(request.params, options),
    };
  }
  const { readSessionHistorySnapshotKernel } = await import("./session-history-snapshot.js");
  return {
    kind: "http",
    snapshot: await readSessionHistorySnapshotKernel(request.params, options),
  };
}
