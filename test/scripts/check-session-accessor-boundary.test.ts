import { describe, expect, it } from "vitest";
import {
  findSessionAccessorBoundaryViolations,
  findTranscriptWriterBoundaryViolations,
  migratedSessionAccessorFiles,
  migratedTranscriptWriterFiles,
} from "../../scripts/check-session-accessor-boundary.mjs";

describe("session accessor boundary guard", () => {
  it("ratchets only the files migrated by the session accessor gateway slice", () => {
    expect(migratedSessionAccessorFiles).toEqual(
      new Set([
        "src/config/sessions/combined-store-gateway.ts",
        "src/gateway/session-utils.ts",
        "src/gateway/sessions-resolve.ts",
        "src/gateway/server-methods/sessions.ts",
      ]),
    );
  });

  it("ratchets only the files migrated by the transcript writer slice", () => {
    expect(migratedTranscriptWriterFiles).toEqual(
      new Set([
        "src/agents/command/attempt-execution.ts",
        "src/config/sessions/transcript.ts",
        "src/gateway/server-methods/chat-transcript-inject.ts",
        "src/sessions/user-turn-transcript.ts",
      ]),
    );
  });

  it("flags legacy reader imports", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { loadSessionStore, readSessionEntries as readEntries } from "../config/sessions.js";
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store reader "loadSessionStore"' },
      { line: 2, reason: 'imports legacy session store reader "readSessionEntries"' },
    ]);
  });

  it("flags direct and namespace legacy reader calls", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        loadSessionStore(storePath);
        sessions.readSessionEntries(storePath);
        sessions["loadSessionStore"](storePath);
      `),
    ).toEqual([
      { line: 2, reason: 'calls legacy session store reader "loadSessionStore"' },
      { line: 3, reason: 'references legacy session store reader "readSessionEntries"' },
      { line: 4, reason: 'references legacy session store reader "loadSessionStore"' },
    ]);
  });

  it("flags aliased namespace reader references", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        const load = sessions.loadSessionStore;
        const { readSessionEntries: readEntries } = sessions;
        const { loadSessionStore } = sessions;
      `),
    ).toEqual([
      { line: 2, reason: 'references legacy session store reader "loadSessionStore"' },
      { line: 3, reason: 'aliases legacy session store reader "readSessionEntries"' },
      { line: 4, reason: 'aliases legacy session store reader "loadSessionStore"' },
    ]);
  });

  it("allows migrated accessor reads", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { listSessionEntries } from "../config/sessions/session-accessor.js";
        listSessionEntries({ storePath });
      `),
    ).toEqual([]);
  });

  it("flags legacy transcript writer imports", () => {
    expect(
      findTranscriptWriterBoundaryViolations(`
        import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.js";
        import { emitSessionTranscriptUpdate as emitUpdate } from "../sessions/transcript-events.js";
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy transcript writer "appendSessionTranscriptMessage"' },
      { line: 3, reason: 'imports legacy transcript writer "emitSessionTranscriptUpdate"' },
    ]);
  });

  it("flags direct and namespace legacy transcript writer calls", () => {
    expect(
      findTranscriptWriterBoundaryViolations(`
        appendSessionTranscriptMessage({ transcriptPath, message });
        transcriptEvents.emitSessionTranscriptUpdate({ sessionFile });
        transcriptAppend["appendSessionTranscriptMessage"]({ transcriptPath, message });
      `),
    ).toEqual([
      { line: 2, reason: 'calls legacy transcript writer "appendSessionTranscriptMessage"' },
      { line: 3, reason: 'references legacy transcript writer "emitSessionTranscriptUpdate"' },
      { line: 4, reason: 'references legacy transcript writer "appendSessionTranscriptMessage"' },
    ]);
  });

  it("allows migrated transcript writer helpers", () => {
    expect(
      findTranscriptWriterBoundaryViolations(`
        import { appendTranscriptMessage, publishTranscriptUpdate } from "../config/sessions/session-accessor.js";
        appendTranscriptMessage(scope, { message });
        publishTranscriptUpdate(scope, { messageId });
      `),
    ).toEqual([]);
  });

  it("ignores comments and strings that describe legacy readers", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        // loadSessionStore and readSessionEntries used to be called here.
        const description = "loadSessionStore";
      `),
    ).toEqual([]);
  });
});
