import { Buffer } from "node:buffer";
import { encodePngRgb } from "../../../src/media/png-encode.js";
import type { ModelCatalogEntry } from "../api/types.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export const LONG_SESSION_SCENARIOS = ["mixed", "paging", "single-run", "direct-run"] as const;
export type LongSessionScenario = (typeof LONG_SESSION_SCENARIOS)[number];
export type LongSessionWorkload =
  | { scenario: "mixed" }
  | {
      scenario: "paging";
      messageCount: number;
      initialMessageCount: number;
      firstEntryId: string;
      deltaCursor: string;
      pages: Array<{ cursor: string; loadedMessages: number; anchorEntryId: string }>;
    }
  | {
      scenario: "single-run" | "direct-run";
      messageCount: number;
      firstEntryId: string;
      firstOutputEntryId: string;
      lastEntryId: string;
    };

type TeamScaleHistoryContent =
  | { type: "text"; text: string }
  | ({ type: "image"; mimeType: string; fileName: string } & (
      | { artifactId: string }
      | { url: string }
    ))
  | { type: "toolCall"; id: string; name: string; arguments: { path: string } }
  | { type: "image"; url: string; alt: string; width: number; height: number }
  | ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"][number];

export type TeamScaleFixtureAsset = {
  body: string | Buffer;
  contentType: string;
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
};

function createTranscriptThumbnail(seed: number): Buffer {
  // Repeated 2×4 texture cells keep real decode work below the 96 KiB rendition ceiling.
  const width = 480;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let noise = Math.imul((x >> 1) + Math.floor(y / 4) * 240 + seed, 0x45d9f3b);
      noise = Math.imul(noise ^ (noise >>> 16), 0x45d9f3b);
      noise ^= noise >>> 16;
      const offset = (y * width + x) * 3;
      pixels[offset] = noise & 255;
      pixels[offset + 1] = (noise >>> 8) & 255;
      pixels[offset + 2] = (noise >>> 16) & 255;
    }
  }
  return encodePngRgb(pixels, width, height);
}

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  richTranscript?: boolean;
  longSessionScenario?: LongSessionScenario;
  duplicateBootReads?: boolean;
  sessionInfo: ControlUiSessionFixture;
  sender?: ControlUiMockPresenceUser;
  historyStateReceipt?: boolean;
  rowFacts?: boolean;
  lateRowFacts?: boolean;
  assets: Map<string, TeamScaleFixtureAsset>;
  models: ModelCatalogEntry[];
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
  const session = options.sessionInfo;
  const olderCursor = (loadedMessages: number) =>
    JSON.stringify([
      "team-scale-older-v1",
      session.key,
      options.now,
      options.messageCount,
      loadedMessages,
    ]);
  const deltaCursor = JSON.stringify([
    "team-scale-history-v1",
    session.key,
    options.now,
    options.messageCount,
    options.largeSnapshot === true,
    options.duplicateBootReads === true,
    options.historyStateReceipt === true,
    options.richTranscript === true,
    options.longSessionScenario ?? null,
  ]);
  const selectHistory = <T>(
    messages: T[],
    pages: Array<{ cursor: string; loadedMessages: number; messages: T[] }> = Array.from(
      { length: Math.max(0, Math.ceil((messages.length - 80) / 1000)) },
      (_, index) => {
        const loaded = 80 + index * 1000;
        const loadedMessages = Math.min(loaded + 1000, messages.length);
        return {
          cursor: olderCursor(loaded),
          loadedMessages,
          messages: messages.slice(messages.length - loadedMessages, messages.length - loaded),
        };
      },
    ),
  ) => {
    const configuredHistory = {
      messages,
      sessionId: session.sessionId,
      sessionInfo: session,
      deltaCursor,
      pendingInputs: { items: [], total: 0, queuedCount: 0 },
      stateRevision: {
        sessionInfo: "fixture-session-v1",
        commands: "fixture-commands-v1",
        pendingInputs: "fixture-pending-inputs-v1",
      },
      ...(options.largeSnapshot || options.historyStateReceipt
        ? {
            hasMore: false,
            totalMessages: messages.length,
            metadata: { commands: [], models: [] },
          }
        : {
            thinkingLevel: null,
            metadata: { commands: [], models: options.models },
            ...(options.inFlightRun ? { inFlightRun: options.inFlightRun } : {}),
          }),
    };
    const windowedHistory = (count: number) => ({
      ...configuredHistory,
      messages: messages.slice(-count),
      hasMore: messages.length > count,
      ...(messages.length > count ? { olderCursor: olderCursor(count) } : {}),
      totalMessages: messages.length,
    });
    // Explicit long-session comparisons measure all rows; the normal fixture models boot's window.
    const fullInitialWindow =
      options.longSessionScenario !== "paging" &&
      (options.historyStateReceipt || options.longSessionScenario !== undefined);
    const limitedHistory = windowedHistory(fullInitialWindow ? messages.length : 80);
    const selectedHistory = {
      cases: [
        {
          match: { sessionKey: session.key, cursor: deltaCursor },
          response: {
            kind: "delta",
            messages: [],
            deltaCursor,
            sessionInfo: configuredHistory.sessionInfo,
            metadata: configuredHistory.metadata,
            pendingInputs: configuredHistory.pendingInputs,
            stateRevision: configuredHistory.stateRevision,
            ...(options.inFlightRun ? { inFlightRun: options.inFlightRun } : {}),
          },
        },
        ...pages.map(({ cursor, loadedMessages, messages: pageMessages }) => ({
          match: { sessionKey: session.key, cursor },
          response: {
            messages: pageMessages,
            hasMore: loadedMessages < messages.length,
            ...(loadedMessages < messages.length
              ? { olderCursor: olderCursor(loadedMessages) }
              : {}),
            totalMessages: messages.length,
            sessionId: session.sessionId,
          },
        })),
        {
          match: { sessionKey: session.key, limit: 80, knownState: {} },
          response: limitedHistory,
        },
        {
          match: { sessionKey: session.key },
          response: options.longSessionScenario === "paging" ? limitedHistory : configuredHistory,
        },
      ],
    };
    return {
      lateRowFacts,
      methodResponses: {
        "chat.startup": selectedHistory,
        "chat.history": selectedHistory,
        ...(lateRowFacts
          ? {
              "controlUi.sessionPreview": {
                cases: [
                  {
                    match: { sessionKey },
                    response: {
                      status: "ok",
                      sessionKey,
                      agentId: "main",
                      title: lateRowFacts.sessionTitle,
                    },
                  },
                ],
              },
              "forge.preview": {
                url: lateRowFacts.prUrl,
                title: "Synthetic thumbnail restoration",
                badge: { label: "Open", tone: "positive" },
              },
              "artifacts.download": {
                cases: [
                  {
                    match: { artifactId: lateRowFacts.artifactId },
                    response: {
                      artifact: {
                        id: lateRowFacts.artifactId,
                        title: "Synthetic ticketed thumbnail",
                        type: "image",
                        mimeType: "image/png",
                        download: { mode: "url" },
                      },
                      url: downloadPath,
                      expiresAt,
                    },
                  },
                ],
              },
            }
          : {}),
      },
    };
  };
  const sessionKey = "agent:main:synthetic-late-row-reference";
  const downloadPath = "/api/artifacts/download/fixture-client/fixture-thumbnail";
  const expiresAt = new Date(options.now + 20 * 60_000).toISOString();
  const runId = "synthetic-row-facts-run";
  const summary = "Synthetic verification failed; retry the check.";
  const lateRowFacts = options.lateRowFacts
    ? {
        sessionTitle: "Synthetic linked research",
        prUrl: "https://github.com/example/cold-load-fixture/pull/42",
        artifactId: "synthetic-late-row-thumbnail",
        cacheableImageSource: "media://inbound/synthetic-l245-cacheable.png",
        metadata: {
          available: true,
          mediaTicket: "synthetic-l245-inbound-ticket",
          mediaTicketExpiresAt: expiresAt,
        },
      }
    : undefined;
  if (options.inFlightRun) {
    Object.assign(options.sessionInfo, {
      hasActiveRun: true,
      status: "running",
      activeRunIds: [options.inFlightRun.runId],
    });
  } else if (options.rowFacts) {
    Object.assign(options.sessionInfo, {
      status: "failed",
      lastRunId: runId,
      lastRunError: summary,
      runtimeMs: 180_000,
      contextTokens: 200_000,
    });
  }
  if (lateRowFacts) {
    options.assets.set(downloadPath, {
      contentType: "image/png",
      body: createTranscriptThumbnail(245),
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="synthetic-ticketed-thumbnail.png"',
      },
    });
    options.assets.set("/__openclaw__/assistant-media", {
      contentType: "image/png",
      body: createTranscriptThumbnail(246),
      headers: { "Cache-Control": "private, no-cache" },
    });
    Object.assign(options.sessionInfo, {
      archived: true,
      archivedAt: options.now - 1_000,
      archivedBy: { type: "human", id: "synthetic-maintainer", label: "Fixture maintainer" },
    });
  }
  const messageIds = Array.from(
    { length: options.messageCount },
    (_, index) => `team-message-${index + 1}`,
  );
  if (
    options.longSessionScenario === "single-run" ||
    options.longSessionScenario === "direct-run"
  ) {
    const singleRunId = "long-session-single-run";
    const historyMessages = messageIds.map((id, index) => {
      const first = index === 0;
      const last = index === messageIds.length - 1;
      const tool = !first && !last && index % 2 === 0;
      const toolCallId = `long-session-tool-${Math.floor((index - 1) / 2)}`;
      const hasToolCall = !first && !last && !tool && index + 1 < messageIds.length - 1;
      return {
        role: first ? "user" : tool ? "toolResult" : "assistant",
        __openclaw: {
          id,
          seq: index + 1,
          ...(first ? { idempotencyKey: `${singleRunId}:user` } : { runId: singleRunId }),
          ...(first && options.sender
            ? {
                senderIdentity: options.sender.identity,
                senderName: options.sender.name,
                senderProfileAvatarUrl: options.sender.avatarUrl,
              }
            : {}),
        },
        timestamp: options.now - (options.messageCount - index) * 1_000,
        ...(tool ? { toolCallId, toolName: "read" } : {}),
        ...(!first && !tool
          ? {
              phase: last ? "final_answer" : "commentary",
              ...(hasToolCall ? { stopReason: "toolUse" } : last ? { stopReason: "stop" } : {}),
            }
          : {}),
        content: [
          {
            type: "text",
            text: first
              ? "Inspect these synthetic checkpoints in one run."
              : last
                ? "All synthetic checkpoints are ready."
                : tool
                  ? `Checkpoint ${index} contains synthetic material.`
                  : `### Project checkpoint ${index + 1}\n\nInspecting synthetic checkpoint.\n\n${index % 5 === 1 ? "```typescript\nconst ready = true;\n```" : "| Item | State |\n| --- | --- |\n| Fixture | Ready |"}`,
          },
          ...(hasToolCall
            ? [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "read",
                  arguments: { path: `checkpoint-${index}.md` },
                },
              ]
            : []),
        ],
      };
    });
    const workload: LongSessionWorkload = {
      scenario: options.longSessionScenario,
      messageCount: historyMessages.length,
      firstEntryId: messageIds[0]!,
      firstOutputEntryId: messageIds[1]!,
      lastEntryId: messageIds.at(-1)!,
    };
    return {
      messageIds,
      historyMessages,
      workload,
      pagination: undefined,
      ...selectHistory(historyMessages),
    };
  }
  const messagesPerWidget = Math.ceil(options.messageCount / options.inlineWidgets);
  const historyMessages = messageIds.map((id, index) => ({
    role:
      (options.largeSnapshot && index % 4 === 2) || (options.richTranscript && index % 8 === 6)
        ? "toolResult"
        : index % 2
          ? "assistant"
          : "user",
    __openclaw: {
      id,
      seq: index + 1,
      ...(options.sender &&
      index % 2 === 0 &&
      !(options.largeSnapshot && index % 4 === 2) &&
      !(options.richTranscript && index % 8 === 6)
        ? {
            senderIdentity: options.sender.identity,
            senderName: options.sender.name,
            senderProfileAvatarUrl: options.sender.avatarUrl,
          }
        : {}),
    },
    ...(options.richTranscript && index % 8 === 6
      ? { toolCallId: `long-session-tool-${index - 1}`, toolName: "read" }
      : {}),
    ...(options.largeSnapshot
      ? {
          idempotencyKey: `synthetic-message-${index}`,
          ...(index % 4 === 2 ? { toolCallId: `synthetic-tool-${index}`, toolName: "read" } : {}),
          openclawResponsesInputReplay: { text: "Synthetic replay metadata. ".repeat(10) },
          usage: { input: 1200, output: 400, totalTokens: 1600 },
        }
      : {}),
    timestamp: options.now - (options.messageCount - index) * 60_000,
    content: [
      ...(options.attachments && index === options.messageCount - 1 ? options.attachments : []),
      ...(lateRowFacts && index === options.messageCount - 1
        ? ([
            {
              type: "image",
              artifactId: lateRowFacts.artifactId,
              mimeType: "image/png",
              fileName: "Synthetic ticketed thumbnail.png",
            },
            {
              type: "image",
              url: lateRowFacts.cacheableImageSource,
              mimeType: "image/png",
              fileName: "Synthetic cacheable thumbnail.png",
            },
          ] satisfies TeamScaleHistoryContent[])
        : []),
      {
        type: "text",
        text: [
          `### Project checkpoint ${index + 1}`,
          "Review the synthetic work queue, confirm the dependency order, and record the owner of the next action. The fixture contains no real conversations or account data.",
          index % 2
            ? "The current implementation is ready for verification. Coverage includes the normal path, a recoverable failure, and the final user-visible result."
            : "Please check the current progress and keep the existing layout stable while the remaining results arrive.",
          ...(lateRowFacts && index === options.messageCount - 1
            ? [`Reference ${sessionKey} and ${lateRowFacts.prUrl}.`]
            : []),
          ...(options.largeSnapshot
            ? ["Synthetic transcript detail and tool output. ".repeat(40)]
            : []),
          ...(options.richTranscript
            ? [
                index === Math.floor(options.messageCount / 2) ? "long-session-search-needle" : "",
                index % 8 === 1
                  ? "```typescript\nconst checkpoints = [1, 2, 3];\nfor (const checkpoint of checkpoints) {\n  console.log({ checkpoint, ready: true });\n}\n```"
                  : index % 8 === 3
                    ? "| Check | Owner | Result |\n| --- | --- | --- |\n| Compile | Harbor | Passed |\n| Review | Scout | Ready |\n| Publish | Cedar | Pending |"
                    : "",
              ]
            : []),
          ...(options.inlineWidgets > 0 &&
          (index % messagesPerWidget === messagesPerWidget - 1 ||
            index === options.messageCount - 1)
            ? [
                `[embed ref="team-scale-chart-${Math.floor(index / messagesPerWidget) + 1}" title="Team metric ${Math.floor(index / messagesPerWidget) + 1}" height="220" /]`,
              ]
            : []),
        ].join("\n\n"),
      },
      ...(options.richTranscript && index % 8 === 5
        ? ([
            {
              type: "toolCall",
              id: `long-session-tool-${index}`,
              name: "read",
              arguments: { path: "synthetic-checkpoint.md" },
            },
          ] satisfies TeamScaleHistoryContent[])
        : []),
      ...(options.richTranscript && index % 16 === 7
        ? ([
            {
              type: "image",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a34sAAAAASUVORK5CYII=",
              alt: `Synthetic checkpoint image ${index + 1}`,
              width: 320,
              height: 180,
            },
          ] satisfies TeamScaleHistoryContent[])
        : []),
    ] satisfies TeamScaleHistoryContent[],
  }));
  if (options.rowFacts) {
    const tail = historyMessages.slice(-3);
    for (const message of tail) {
      const { __openclaw: identity } = message;
      Object.assign(message, { runId });
      Object.assign(identity, { runId });
    }
    Object.assign(tail[0]!, { role: "user" });
    Object.assign(tail[1]!, {
      role: "toolResult",
      toolCallId: "synthetic-row-facts-read",
      toolName: "read",
      content: [{ type: "text", text: "Synthetic verification output." }],
      activity: [
        {
          itemId: "tool:synthetic-row-facts-read",
          toolCallId: "synthetic-row-facts-read",
          kind: "tool",
          phase: "end",
          name: "read",
          title: "Read",
          status: "completed",
        },
      ],
    });
    Object.assign(tail[2]!, {
      model: "gpt-5-mini",
      usage: { input: 1200, output: 400, cost: { total: 0.01 } },
    });
    const id = "synthetic-row-facts-failure";
    messageIds.push(id);
    historyMessages.push(
      Object.assign({}, historyMessages.at(-1)!, {
        role: "custom",
        customType: "run-failed-before-reply",
        content: [{ type: "text", text: summary }],
        openclawRunError: { runId, summary },
        __openclaw: { id, seq: options.messageCount + 1, runId },
        timestamp: options.now + 1,
      }),
    );
  }
  if (options.longSessionScenario !== "paging") {
    const workload: LongSessionWorkload = { scenario: "mixed" };
    return {
      messageIds,
      historyMessages,
      workload,
      pagination: undefined,
      ...selectHistory(historyMessages),
    };
  }
  const initialMessageCount = Math.min(80, historyMessages.length);
  const pages = Array.from(
    { length: Math.ceil((historyMessages.length - initialMessageCount) / 1000) },
    (_, index) => {
      const offset = initialMessageCount + index * 1000;
      const loadedMessages = Math.min(offset + 1000, historyMessages.length);
      return {
        cursor: olderCursor(offset),
        loadedMessages,
        anchorEntryId: messageIds[historyMessages.length - offset]!,
        messages: historyMessages.slice(
          historyMessages.length - loadedMessages,
          historyMessages.length - offset,
        ),
      };
    },
  );
  const workload: LongSessionWorkload = {
    scenario: "paging",
    messageCount: historyMessages.length,
    initialMessageCount,
    firstEntryId: messageIds[0]!,
    deltaCursor,
    pages: pages.map(({ cursor, loadedMessages, anchorEntryId }) => ({
      cursor,
      loadedMessages,
      anchorEntryId,
    })),
  };
  const pagination = {
    deferredRequests: pages.map(({ cursor }) => ({
      method: "chat.history",
      match: { sessionKey: session.key, cursor },
    })),
  };
  return {
    messageIds,
    historyMessages,
    workload,
    pagination,
    ...selectHistory(historyMessages, pages),
  };
}
