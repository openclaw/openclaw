import { afterAll, describe, expect, it } from "vitest";
import { findSessionTranscriptReaderBoundaryViolations } from "../../scripts/check-session-transcript-reader-boundary.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string) {
  return [content, "source.ts", parser.parseSourceFile("source.ts", content)] as const;
}

describe("session transcript reader boundary guard", () => {
  it("flags legacy transcript reader imports", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(
        ...parseFixture(`
        import { readSessionMessagesAsync, loadSessionEntry } from "./session-utils.js";
        import { readRecentSessionMessages as readRecent } from "./session-utils.fs.js";
      `),
      ),
    ).toEqual([
      {
        line: 2,
        reason:
          'imports transcript reader "readSessionMessagesAsync" from legacy module "./session-utils.js"',
      },
      {
        line: 3,
        reason:
          'imports transcript reader "readRecentSessionMessages" from legacy module "./session-utils.fs.js"',
      },
    ]);
  });

  it("flags namespace legacy transcript reader references", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(
        ...parseFixture(`
        import * as sessionUtils from "./session-utils.js";
        sessionUtils.readSessionMessagesAsync();
        sessionUtils["readRecentSessionMessages"]();
        const { readSessionMessages } = sessionUtils;
      `),
      ),
    ).toEqual([
      { line: 3, reason: 'references legacy transcript reader "readSessionMessagesAsync"' },
      { line: 4, reason: 'references legacy transcript reader "readRecentSessionMessages"' },
      { line: 5, reason: 'aliases legacy transcript reader "readSessionMessages"' },
    ]);
  });

  it("flags legacy transcript reader re-exports", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(
        ...parseFixture(`
        export { readSessionMessagesAsync } from "./session-utils.js";
        export { readRecentSessionMessages as readRecent } from "./session-utils.fs.js";
        export * as sessionUtils from "./session-utils.js";
        export * from "./session-utils.fs.js";
      `),
      ),
    ).toEqual([
      {
        line: 2,
        reason:
          're-exports transcript reader "readSessionMessagesAsync" from legacy module "./session-utils.js"',
      },
      {
        line: 3,
        reason:
          're-exports transcript reader "readRecentSessionMessages" from legacy module "./session-utils.fs.js"',
      },
      {
        line: 4,
        reason: 're-exports transcript reader namespace from legacy module "./session-utils.js"',
      },
      {
        line: 5,
        reason: 're-exports transcript readers from legacy module "./session-utils.fs.js"',
      },
    ]);
  });

  it("allows migrated reader facade imports and non-reader session utilities", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(
        ...parseFixture(`
        import { readSessionMessagesAsync } from "./session-transcript-readers.js";
        import { loadSessionEntry } from "./session-utils.js";
        export { readSessionMessagesAsync };
        await readSessionMessagesAsync(scope, opts);
        loadSessionEntry("agent:main");
      `),
      ),
    ).toEqual([]);
  });

  it("allows reader-named destructuring from non-legacy objects", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(
        ...parseFixture(`
        const { readSessionMessagesAsync } = deps;
        const { readSessionMessages: readMessages } = mockReaders;
      `),
      ),
    ).toEqual([]);
  });

  it("flags storage-specific reader aliases in migrated files", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(
        ...parseFixture(`
        import { readSessionMessagesAsync as readSessionMessagesFromFileAsync } from "./session-transcript-readers.js";
        await readSessionMessagesFromFileAsync(scope, opts);
      `),
      ),
    ).toEqual([
      {
        line: 2,
        reason: 'uses storage-specific transcript reader alias "readSessionMessagesFromFileAsync"',
      },
      {
        line: 3,
        reason: 'uses storage-specific transcript reader alias "readSessionMessagesFromFileAsync"',
      },
    ]);
  });
});
