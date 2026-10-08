import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { classifyClaudeCliHistoryLine } from "./cli-session-history.claude-activity.js";
import { readClaudeCliFallbackSeed } from "./cli-session-history.claude.js";
import { buildLegacyReseedPrompt } from "./cli-session-history.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const userTurn = (uuid: string, content: string) => ({
  type: "user",
  uuid,
  message: { role: "user", content },
});
const assistantTurn = (uuid: string, text: string) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text }] },
});
const boundary = (content = "Conversation compacted") => ({
  type: "system",
  subtype: "compact_boundary",
  content,
});

describe("Claude history activity rows", () => {
  it.each(["null", "not json"])("ignores non-record or malformed activity row %s", (line) => {
    expect(
      classifyClaudeCliHistoryLine({ line, cliSessionId: "activity", sourceLineNumber: 1 }),
    ).toEqual({ humanTurn: false });
  });
});

describe("readClaudeCliFallbackSeed", () => {
  let homeDir: string;
  let projectsDir: string;
  const SESSION_ID = "fallback-seed-session";

  beforeEach(async () => {
    homeDir = path.join(tempDirs.make("openclaw-fallback-seed-"), "home");
    projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectsDir, { recursive: true });
  });

  function readFallbackSeed(cliSessionId = SESSION_ID) {
    return readClaudeCliFallbackSeed({ cliSessionId, homeDir });
  }

  async function writeJsonl(lines: ReadonlyArray<unknown>): Promise<void> {
    const file = path.join(projectsDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  }

  it.each(["missing", "empty", "path escape"])("returns no seed for %s", async (kind) => {
    if (kind === "empty") {
      await writeJsonl([{ ...userTurn("u-side", "sidechain user turn"), isSidechain: true }]);
    }
    expect(readFallbackSeed(kind === "path escape" ? "../escape" : SESSION_ID)).toBeUndefined();
  });

  it("collects valid turns through the HOME-resolved session store despite null rows", async () => {
    const reseedPrompt = buildLegacyReseedPrompt();
    await writeJsonl([
      userTurn("u-reseed", reseedPrompt),
      userTurn("u-1", "first user prompt"),
      null,
      assistantTurn("a-1", "first assistant reply"),
      userTurn("u-2", "second user prompt"),
    ]);
    const seed = await withEnvAsync({ HOME: homeDir }, async () =>
      readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID }),
    );
    expect(seed).toMatchObject({
      recentTurns: [
        { role: "user", content: reseedPrompt },
        { role: "user", content: "first user prompt" },
        { role: "assistant", content: [{ type: "text", text: "first assistant reply" }] },
        { role: "user", content: "second user prompt" },
      ],
    });
    expect(seed?.summaryText).toBeUndefined();
  });

  it.each([
    {
      name: "latest explicit summary",
      lines: [
        userTurn("u-pre", "PRE-COMPACT user turn"),
        assistantTurn("a-pre", "PRE-COMPACT assistant turn"),
        { type: "summary", summary: "EARLY summary that should be superseded.", leafUuid: "a-pre" },
        boundary(),
        userTurn("u-mid", "mid-window turn"),
        { type: "summary", summary: "LATER summary that must win.", leafUuid: "u-mid" },
        boundary(),
        userTurn("u-tail", "tail turn"),
        assistantTurn("a-tail", "tail reply"),
      ],
      expected: {
        summaryText: "LATER summary that must win.",
        recentTurns: [
          { role: "user", content: "tail turn" },
          { role: "assistant", content: [{ type: "text", text: "tail reply" }] },
        ],
      },
    },
    {
      name: "boundary fallback after a compaction without a summary",
      lines: [
        { type: "summary", summary: "FIRST compact summary", leafUuid: "x" },
        boundary("Conversation compacted (1)"),
        userTurn("u-mid", "post-first-compact turn"),
        boundary("Conversation compacted (2)"),
        userTurn("u-tail", "post-second-compact turn"),
      ],
      expected: {
        summaryText: "Conversation compacted (2)",
        recentTurns: [{ role: "user", content: "post-second-compact turn" }],
      },
    },
    {
      name: "trailing summary without a boundary",
      lines: [
        userTurn("u-1", "earlier turn"),
        { type: "summary", summary: "trailing summary without boundary", leafUuid: "x" },
        userTurn("u-2", "later turn"),
      ],
      expected: { summaryText: "trailing summary without boundary" },
    },
  ])("seeds from the $name", async ({ lines, expected }) => {
    await writeJsonl(lines);
    expect(readFallbackSeed()).toMatchObject(expected);
  });
});
