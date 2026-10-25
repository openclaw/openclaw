import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTranscriptEventReader } from "./session-sqlite-migration-readers.js";
import { verifyTranscriptEvents } from "./session-sqlite-transcript-verification.js";

const verified = { events: 2, missingEvents: 0, sqliteEvents: 2 };
const legacyMessage = {
  role: "user",
  content: "see attached",
  MediaPath: "/tmp/photo.png",
  MediaPaths: ["/tmp/photo.png", "/tmp/document.pdf"],
  MediaType: "image/png",
  MediaTypes: ["image/png", "application/pdf"],
  __openclaw: { retained: "message metadata" },
};
const providerMessage = (provider: string) => ({
  role: "assistant",
  content: [{ type: "text", text: "stored once" }],
  provider,
  api: provider === "openai" ? "openai-chatgpt-responses" : "openai-codex-responses",
});
const headingMessage = (normalized: boolean) => ({
  role: "user",
  content: normalized
    ? 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"chat_type":"direct"}\n```\nQuestion'
    : 'Conversation info (untrusted metadata):\n```json\n{"chat_type":"direct"}\n```\nQuestion',
});

it.each(["legacy media", "inbound headings", "openai", "openai-codex"] as const)(
  "verifies %s without changing historical receipts",
  async (kind) => {
    const media = kind === "legacy media";
    const headings = kind === "inbound headings";
    await withOpenClawTestState(
      { label: media ? "verify-legacy-media" : "verify-provider-retry" },
      async (state) => {
        const sessionId = media ? "legacy-media" : "provider-retry";
        const header = { type: "session", id: sessionId, version: 3 };
        const event = (message: unknown) => ({
          type: "message",
          id: "m1",
          parentId: null,
          message,
        });
        const write = (message: unknown) =>
          state.writeText(
            media ? "legacy.jsonl" : "source.jsonl",
            `${JSON.stringify(header)}\n${JSON.stringify(event(message))}\n`,
          );
        const filename = await write(
          media ? legacyMessage : headings ? headingMessage(true) : providerMessage(kind),
        );
        const scope = {
          agentId: "main",
          env: state.env,
          sessionId,
          sessionKey: media ? `agent:main:${sessionId}` : "agent:main:main",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await importSqliteSessionRows({
          ...scope,
          entry: { sessionId, updatedAt: 1 },
          readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
        });
        const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const source = { path: filename, sessionId, originalPath: filename };
        const verify = (mode: Parameters<typeof verifyTranscriptEvents>[2]) =>
          verifyTranscriptEvents(db, source, mode);
        const stored = loadTranscriptEventsSync(scope);
        if (headings) {
          await write(headingMessage(false));
          const original = fs.readFileSync(filename, "utf8");
          for (const mode of ["ordered", "contained", "appendable"] as const) {
            expect(verify(mode)).toEqual(verified);
          }
          expect(fs.readFileSync(filename, "utf8")).toBe(original);
          await write({ ...headingMessage(false), content: headingMessage(false).content + "!" });
          expect(verify("ordered")).toBeUndefined();
          expect(verify("contained")).toBeUndefined();
          expect(() => verify("appendable")).toThrow(
            "Legacy event m1 conflicts with the SQLite event of the same identity",
          );
        } else if (media) {
          const original = fs.readFileSync(filename, "utf8");
          expect(stored[1]).toMatchObject({
            id: "m1",
            message: {
              role: "user",
              content: "see attached",
              __openclaw: {
                retained: "message metadata",
                media: [
                  { path: "/tmp/photo.png", contentType: "image/png" },
                  { path: "/tmp/document.pdf", contentType: "application/pdf" },
                ],
              },
            },
          });
          for (const mode of ["ordered", "contained", "appendable"] as const) {
            expect(verify(mode)).toEqual(verified);
          }
          expect(fs.readFileSync(filename, "utf8")).toBe(original);
          for (const changed of [
            { content: "changed" },
            { MediaPath: "/tmp/other.png", MediaPaths: ["/tmp/other.png", "/tmp/document.pdf"] },
            { __openclaw: { retained: "changed metadata" } },
          ]) {
            await write({ ...legacyMessage, ...changed });
            expect(verify("ordered")).toBeUndefined();
            expect(verify("contained")).toBeUndefined();
            expect(() => verify("appendable")).toThrow(
              "Legacy event m1 conflicts with the SQLite event of the same identity",
            );
          }
        } else {
          await write(providerMessage(kind === "openai" ? "openai-codex" : "openai"));
          expect(verify("ordered")).toBeUndefined();
          for (const mode of ["contained", "appendable"] as const) {
            expect(verify(mode)).toEqual(verified);
          }
        }
        expect(loadTranscriptEventsSync(scope)).toEqual(stored);
      },
    );
  },
);
