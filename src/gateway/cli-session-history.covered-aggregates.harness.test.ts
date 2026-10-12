import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  upsertSessionEntryCore,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";

type ReplaceTranscriptEvents = (
  scope: { agentId: string; sessionKey: string; sessionId: string },
  events: readonly Record<string, unknown>[],
) => Promise<void>;

function readReplaceTranscriptEvents(loaded: unknown): ReplaceTranscriptEvents | undefined {
  const candidate = asOptionalRecord(loaded)?.replaceTranscriptEvents;
  return typeof candidate === "function" ? (candidate as ReplaceTranscriptEvents) : undefined;
}

// The writer left the session-accessor barrel for a test-support module. Try that
// module first, then the older production writer, so this harness loads on both trees.
async function loadReplaceTranscriptEvents(): Promise<ReplaceTranscriptEvents> {
  const specifiers = [
    "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js",
    "../config/sessions/session-accessor.sqlite-transcript-write.js",
  ];
  for (const specifier of specifiers) {
    try {
      const replace = readReplaceTranscriptEvents(
        await import(new URL(specifier, import.meta.url).href),
      );
      if (replace) {
        return replace;
      }
    } catch {
      // Missing on checkouts that still export the writer from the other module.
    }
  }
  throw new Error("replaceTranscriptEvents is unavailable");
}

const RESUME_DRIFT_NOTE =
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.";
const CLI_SESSION_ID = "7c1f0a52-3d0e-4d6a-9c4b-2f0d9e7b1a11";
const STARTED_AT = Date.parse("2026-03-26T16:00:00.000Z");

type HistoryPage = {
  messages?: unknown[];
  totalMessages?: number;
};

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function textOf(message: unknown): string {
  const record = asOptionalRecord(message);
  const content = record?.content;
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const item = asOptionalRecord(block);
      if (typeof item?.text === "string") {
        parts.push(item.text);
      }
      if (item?.type === "tool_result") {
        parts.push("[tool_result]");
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function proofLine(message: unknown): string {
  const record = asOptionalRecord(message) ?? {};
  const meta = asOptionalRecord(record["__openclaw"]) ?? {};
  const role = typeof record.role === "string" ? record.role : "?";
  const timestamp = typeof record.timestamp === "number" ? iso(record.timestamp) : "-";
  const key = typeof record.idempotencyKey === "string" ? record.idempotencyKey : "-";
  const externalId = typeof meta.externalId === "string" ? meta.externalId : "-";
  return `${role} | ${timestamp} | ${key} | ${externalId} | ${JSON.stringify(textOf(message))}`;
}

function aggregate(text: string, runId: string, timestamp: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    idempotencyKey: `cli-assistant:${runId}`,
  };
}

function claudeLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

describe("cli session history covered aggregate harness", () => {
  it("serves chat.history without covered aggregates across backward local pages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-history-coverage",
        sessionId: "cli-history-coverage-proof",
      };
      const ping1 = STARTED_AT + 60_000;
      const ping2 = STARTED_AT + 120_000;
      const ping3 = STARTED_AT + 12 * 60_000;
      const resumeAt = STARTED_AT + 30 * 60_000;
      const toolAt = STARTED_AT + 40 * 60_000;
      const partialAt = STARTED_AT + 50 * 60_000;
      const locals = [
        { role: "user", content: "Summarize the plan.", timestamp: STARTED_AT },
        aggregate(
          "Checking the notes first.\nThe plan has three steps: build, test, ship.",
          "plan",
          STARTED_AT + 3,
        ),
        { role: "user", content: "ping", timestamp: ping1 },
        aggregate("Working on it.\nAll done.", "ping-1", ping1 + 3),
        { role: "user", content: "ping", timestamp: ping2 },
        aggregate("Working on it.\nAll done.", "ping-2", ping2 + 3),
        { role: "user", content: "ping", timestamp: ping3 },
        aggregate("Working on it.\nAll done.", "ping-3", ping3 + 3),
        { role: "user", content: "test ping...", timestamp: resumeAt },
        aggregate("Resumed check.\nResumed answer.", "resume", resumeAt + 3),
        { role: "user", content: "run the tool", timestamp: toolAt },
        aggregate("I'll check.\nThe answer is 4.", "tool", toolAt + 4),
        { role: "user", content: "Anything else?", timestamp: partialAt },
        aggregate(
          "Done. Nothing else to add.\nPing me if the plan changes.",
          "partial",
          partialAt + 3,
        ),
        ...Array.from({ length: 56 }, (_, index) => ({
          role: "assistant",
          content: `pad ${index + 1}`,
          timestamp: STARTED_AT + 4_000_000 + index,
        })),
      ];
      expect(locals).toHaveLength(70);

      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: STARTED_AT,
        providerOverride: "claude-cli",
        modelOverride: "claude-sonnet-4-6",
        cliSessionBindings: { "claude-cli": { sessionId: CLI_SESSION_ID } },
      });
      const replaceTranscriptEvents = await loadReplaceTranscriptEvents();
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...locals.map((message, index) => ({
          type: "message",
          id: `local-${index + 1}`,
          parentId: index === 0 ? null : `local-${index}`,
          message,
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);

      const projectDir = path.join(state.home, ".claude", "projects", "coverage-proof");
      await fs.mkdir(projectDir, { recursive: true });
      const native = [
        userLine("plan-user", STARTED_AT, "Summarize the plan."),
        assistantLine("plan-interim", STARTED_AT + 1, "Checking the notes first."),
        assistantLine("plan-final", STARTED_AT + 2, "The plan has three steps: build, test, ship."),
        userLine("ping-2-user", ping2, "ping"),
        assistantLine("ping-2-interim", ping2 + 1, "Working on it."),
        assistantLine("ping-2-final", ping2 + 2, "All done."),
        userLine("ping-3-user", ping3, "ping"),
        assistantLine("ping-3-interim", ping3 + 1, "Working on it."),
        assistantLine("ping-3-final", ping3 + 2, "All done."),
        userLine("resume-user", resumeAt, `${RESUME_DRIFT_NOTE}\n\ntest ping...`),
        assistantLine("resume-interim", resumeAt + 1, "Resumed check."),
        assistantLine("resume-final", resumeAt + 2, "Resumed answer."),
        userLine("tool-user", toolAt, "run the tool"),
        claudeLine({
          type: "assistant",
          uuid: "tool-mixed",
          sessionId: CLI_SESSION_ID,
          timestamp: iso(toolAt + 1),
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
              { type: "text", text: "I'll check." },
              { type: "tool_use", id: "tool-1", name: "calc", input: {} },
            ],
            stop_reason: "tool_use",
          },
        }),
        claudeLine({
          type: "user",
          uuid: "tool-result",
          sessionId: CLI_SESSION_ID,
          timestamp: iso(toolAt + 2),
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "4" }],
          },
        }),
        assistantLine("tool-final", toolAt + 3, "The answer is 4."),
        userLine("partial-user", partialAt, "Anything else?"),
        assistantLine("partial-final", partialAt + 2, "Ping me if the plan changes."),
      ];
      await fs.writeFile(
        path.join(projectDir, `${CLI_SESSION_ID}.jsonl`),
        `${native.join("\n")}\n`,
      );

      const context = await createHistoryReadContext();
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      let page: HistoryPage | undefined;
      await handler({
        params: { sessionKey: scope.sessionKey, limit: 200 },
        context,
        req: { type: "req", id: "coverage-proof", method: "chat.history" },
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          page = payload as HistoryPage;
        },
      });
      const messages = expectDefined(page?.messages, "chat.history messages");
      const proof = messages.map(proofLine).filter((line) => !line.includes('"pad '));
      const keys = messages.map((message) => asOptionalRecord(message)?.idempotencyKey);

      expect(page?.totalMessages).toBe(messages.length);
      expect(keys).not.toContain("cli-assistant:plan");
      expect(keys).toContain("cli-assistant:ping-1");
      expect(keys).toContain("cli-assistant:ping-2");
      expect(keys).not.toContain("cli-assistant:ping-3");
      expect(keys).not.toContain("cli-assistant:resume");
      expect(keys).not.toContain("cli-assistant:tool");
      expect(keys).toContain("cli-assistant:partial");
      expect(proof.some((line) => line.includes("[tool_result]"))).toBe(true);
      expect(proof.some((line) => line.includes("The answer is 4."))).toBe(true);
      expect(JSON.stringify(proof)).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(JSON.stringify(proof)).not.toMatch(/sk-[A-Za-z0-9]/);
      // Offsets below a second render as milliseconds. The repeated "ping" import
      // still dedupes onto the first in-window local user; coverage leaves both
      // summaries in place because that window does not name one turn.
      expect(proof).toEqual([
        'user | 2026-03-26T16:00:00.000Z | - | plan-user | "Summarize the plan."',
        'assistant | 2026-03-26T16:00:00.001Z | - | plan-interim | "Checking the notes first."',
        'assistant | 2026-03-26T16:00:00.002Z | - | plan-final | "The plan has three steps: build, test, ship."',
        'user | 2026-03-26T16:01:00.000Z | - | ping-2-user | "ping"',
        'assistant | 2026-03-26T16:01:00.003Z | cli-assistant:ping-1 | - | "Working on it. All done."',
        'user | 2026-03-26T16:02:00.000Z | - | - | "ping"',
        'assistant | 2026-03-26T16:02:00.001Z | - | ping-2-interim | "Working on it."',
        'assistant | 2026-03-26T16:02:00.002Z | - | ping-2-final | "All done."',
        'assistant | 2026-03-26T16:02:00.003Z | cli-assistant:ping-2 | - | "Working on it. All done."',
        'user | 2026-03-26T16:12:00.000Z | - | ping-3-user | "ping"',
        'assistant | 2026-03-26T16:12:00.001Z | - | ping-3-interim | "Working on it."',
        'assistant | 2026-03-26T16:12:00.002Z | - | ping-3-final | "All done."',
        'user | 2026-03-26T16:30:00.000Z | - | resume-user | "test ping..."',
        'assistant | 2026-03-26T16:30:00.001Z | - | resume-interim | "Resumed check."',
        'assistant | 2026-03-26T16:30:00.002Z | - | resume-final | "Resumed answer."',
        'user | 2026-03-26T16:40:00.000Z | - | tool-user | "run the tool"',
        'assistant | 2026-03-26T16:40:00.001Z | - | tool-mixed | "I\'ll check."',
        'user | 2026-03-26T16:40:00.002Z | - | tool-result | "[tool_result]"',
        'assistant | 2026-03-26T16:40:00.003Z | - | tool-final | "The answer is 4."',
        'user | 2026-03-26T16:50:00.000Z | - | partial-user | "Anything else?"',
        'assistant | 2026-03-26T16:50:00.002Z | - | partial-final | "Ping me if the plan changes."',
        'assistant | 2026-03-26T16:50:00.003Z | cli-assistant:partial | - | "Done. Nothing else to add. Ping me if the plan changes."',
      ]);
    });
  });

  it("keeps managed audio on a keyed aggregate whose text is covered by native segments", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cliSessionId = "7c1f0a52-3d0e-4d6a-9c4b-2f0d9e7b1a22";
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-history-audio",
        sessionId: "cli-history-audio-proof",
      };
      const askedAt = STARTED_AT;
      const managedAudioUrl = "/api/chat/media/outgoing/main/checking/full";
      const audio = { type: "audio", url: managedAudioUrl, openUrl: managedAudioUrl };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: askedAt,
        providerOverride: "claude-cli",
        modelOverride: "claude-sonnet-4-6",
        cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
      });
      const replaceTranscriptEvents = await loadReplaceTranscriptEvents();
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "local-user",
          parentId: null,
          message: { role: "user", content: "status", timestamp: askedAt },
        },
        {
          type: "message",
          id: "local-audio",
          parentId: "local-user",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Checking.\nDone." }],
            openclawDisplayContent: [{ type: "text", text: "Checking.\nDone." }, audio],
            timestamp: askedAt + 3,
            idempotencyKey: "cli-assistant:audio",
          },
        },
        {
          type: "message",
          id: "local-text-user",
          parentId: "local-audio",
          message: { role: "user", content: "next", timestamp: askedAt + 9_000 },
        },
        {
          type: "message",
          id: "local-text",
          parentId: "local-text-user",
          message: aggregate("Only text.\nStill only text.", "text", askedAt + 10_000),
        },
      ]);
      await waitForSessionTranscriptProjection(scope);

      const projectDir = path.join(state.home, ".claude", "projects", "audio-proof");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${cliSessionId}.jsonl`),
        [
          userLine("audio-user", askedAt, "status", cliSessionId),
          assistantLine("audio-interim", askedAt + 1, "Checking.", cliSessionId),
          assistantLine("audio-final", askedAt + 2, "Done.", cliSessionId),
          userLine("text-user", askedAt + 9_000, "next", cliSessionId),
          assistantLine("text-interim", askedAt + 9_001, "Only text.", cliSessionId),
          assistantLine("text-final", askedAt + 9_002, "Still only text.", cliSessionId),
        ].join("\n") + "\n",
      );

      const context = await createHistoryReadContext();
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      let page: HistoryPage | undefined;
      await handler({
        params: { sessionKey: scope.sessionKey, limit: 50 },
        context,
        req: { type: "req", id: "audio-proof", method: "chat.history" },
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          page = payload as HistoryPage;
        },
      });
      const messages = expectDefined(page?.messages, "chat.history messages");
      const keys = messages.map((message) => asOptionalRecord(message)?.idempotencyKey);
      const audioMessage = messages.find(
        (message) => asOptionalRecord(message)?.idempotencyKey === "cli-assistant:audio",
      );
      const audioContent = asOptionalRecord(audioMessage)?.content;

      expect(keys).toContain("cli-assistant:audio");
      expect(keys).not.toContain("cli-assistant:text");
      expect(Array.isArray(audioContent)).toBe(true);
      expect(audioContent).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "audio", url: managedAudioUrl })]),
      );
      expect(messages.map(textOf).join("\n")).toContain("Checking.");
      expect(messages.map(textOf).join("\n")).toContain("Done.");
    });
  });
});

function userLine(
  uuid: string,
  timestamp: number,
  content: string,
  sessionId = CLI_SESSION_ID,
): string {
  return claudeLine({
    type: "user",
    uuid,
    sessionId,
    timestamp: iso(timestamp),
    message: { role: "user", content },
  });
}

function assistantLine(
  uuid: string,
  timestamp: number,
  text: string,
  sessionId = CLI_SESSION_ID,
): string {
  return claudeLine({
    type: "assistant",
    uuid,
    sessionId,
    timestamp: iso(timestamp),
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  });
}
