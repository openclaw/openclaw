import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../config/sessions/paths.js";
import {
  resolveSessionTranscriptCandidates,
  resolveStableSessionEndTranscript,
} from "./session-transcript-paths.js";

describe("resolveSessionTranscriptCandidates", () => {
  it("returns sqlite locators and does not synthesize legacy jsonl paths", () => {
    expect(resolveSessionTranscriptCandidates("s2", path.join("/tmp", "s1.jsonl"), "main")).toEqual(
      [createSqliteSessionTranscriptLocator({ agentId: "main", sessionId: "s2" })],
    );
  });

  it("preserves explicit sqlite locators before generated agent locator candidates", () => {
    const topicLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "s1",
      topicId: "alerts",
    });

    expect(resolveSessionTranscriptCandidates("s2", topicLocator, "main")).toEqual([
      topicLocator,
      createSqliteSessionTranscriptLocator({ agentId: "main", sessionId: "s2" }),
    ]);
  });

  it("does not return legacy paths when no agent can resolve a database locator", () => {
    expect(resolveSessionTranscriptCandidates("s1", path.join("/tmp", "s1.jsonl"))).toEqual([]);
  });
});

describe("resolveStableSessionEndTranscript", () => {
  it("uses a generated sqlite locator instead of a legacy sessionFile path", () => {
    expect(
      resolveStableSessionEndTranscript({
        sessionId: "s1",
        sessionFile: path.join("/tmp", "s1.jsonl"),
        agentId: "main",
      }),
    ).toEqual({
      sessionFile: createSqliteSessionTranscriptLocator({ agentId: "main", sessionId: "s1" }),
    });
  });
});
