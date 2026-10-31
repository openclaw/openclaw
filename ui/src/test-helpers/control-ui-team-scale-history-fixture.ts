import { Buffer } from "node:buffer";
import { encodePngRgb } from "../../../src/media/png-encode.js";
import type { ModelCatalogEntry } from "../api/types.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

type TeamScaleHistoryContent =
  | { type: "text"; text: string }
  | ({ type: "image"; mimeType: string; fileName: string } & (
      | { artifactId: string }
      | { url: string }
    ))
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
  duplicateBootReads?: boolean;
  sessionInfo: ControlUiSessionFixture;
  sender?: ControlUiMockPresenceUser;
  rowFacts?: boolean;
  lateRowFacts?: boolean;
  assets: Map<string, TeamScaleFixtureAsset>;
  models: ModelCatalogEntry[];
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
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
  const messagesPerWidget = Math.ceil(options.messageCount / options.inlineWidgets);
  const historyMessages = messageIds.map((id, index) => ({
    role:
      options.largeSnapshot && index % 4 === 2 ? "toolResult" : index % 2 ? "assistant" : "user",
    __openclaw: {
      id,
      seq: index + 1,
      ...(options.sender && index % 2 === 0 && !(options.largeSnapshot && index % 4 === 2)
        ? {
            senderIdentity: options.sender.identity,
            senderName: options.sender.name,
            senderProfileAvatarUrl: options.sender.avatarUrl,
          }
        : {}),
    },
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
          ...(index % messagesPerWidget === messagesPerWidget - 1 ||
          index === options.messageCount - 1
            ? [
                `[embed ref="team-scale-chart-${Math.floor(index / messagesPerWidget) + 1}" title="Team metric ${Math.floor(index / messagesPerWidget) + 1}" height="220" /]`,
              ]
            : []),
        ].join("\n\n"),
      },
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
  const deltaCursor = JSON.stringify([
    "team-scale-history-v1",
    options.sessionInfo.key,
    options.now,
    options.messageCount,
    options.largeSnapshot === true,
    options.duplicateBootReads === true,
  ]);
  const configuredHistory = {
    messages: historyMessages,
    sessionId: options.sessionInfo.sessionId,
    sessionInfo: options.sessionInfo,
    deltaCursor,
    pendingInputs: { items: [], total: 0, queuedCount: 0 },
    stateRevision: {
      sessionInfo: "fixture-session-v1",
      commands: "fixture-commands-v1",
      pendingInputs: "fixture-pending-inputs-v1",
    },
    ...(options.largeSnapshot
      ? {
          hasMore: false,
          totalMessages: historyMessages.length,
          metadata: { commands: [], models: [] },
        }
      : {
          thinkingLevel: null,
          metadata: { commands: [], models: options.models },
          ...(options.inFlightRun ? { inFlightRun: options.inFlightRun } : {}),
        }),
  };
  const selectedHistory = {
    cases: [
      {
        match: { sessionKey: options.sessionInfo.key, cursor: deltaCursor },
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
      {
        match: { sessionKey: options.sessionInfo.key, limit: 80, knownState: {} },
        response: {
          ...configuredHistory,
          messages: historyMessages.slice(-80),
          hasMore: historyMessages.length > 80,
          ...(historyMessages.length > 80 ? { nextOffset: 80 } : {}),
          totalMessages: historyMessages.length,
        },
      },
      { match: { sessionKey: options.sessionInfo.key }, response: configuredHistory },
    ],
  };
  return {
    messageIds,
    historyMessages,
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
}
