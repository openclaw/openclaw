import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { classifyClaudeCliHistoryLine } from "./cli-session-history.claude-activity.js";
import { readClaudeCliFallbackSeed } from "./cli-session-history.claude.js";
import { buildLegacyReseedPrompt } from "./cli-session-history.test-support.js";
import { expectRecordFields } from "./test-helpers.assertions.js";

type ClaudeCliFallbackSeed = NonNullable<ReturnType<typeof readClaudeCliFallbackSeed>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireFallbackSeed(
  seed: ReturnType<typeof readClaudeCliFallbackSeed>,
  label: string,
): ClaudeCliFallbackSeed {
  if (!seed) {
    throw new Error(`expected ${label} fallback seed`);
  }
  return seed;
}

describe("Claude history activity rows", () => {
  it.each(["null", "[]", "42", "true", '"ignored"', "not json"])(
    "ignores non-record or malformed activity row %s",
    (line) => {
      expect(
        classifyClaudeCliHistoryLine({ line, cliSessionId: "activity", sourceLineNumber: 1 }),
      ).toEqual({ humanTurn: false });
    },
  );
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

  function readFallbackSeed(
    cliSessionId = SESSION_ID,
  ): ReturnType<typeof readClaudeCliFallbackSeed> {
    return readClaudeCliFallbackSeed({ cliSessionId, homeDir });
  }

  function readFallbackSeedFromHome(
    cliSessionId = SESSION_ID,
  ): Promise<ReturnType<typeof readClaudeCliFallbackSeed>> {
    return withEnvAsync({ HOME: homeDir }, async () => readClaudeCliFallbackSeed({ cliSessionId }));
  }

  async function writeJsonl(lines: ReadonlyArray<unknown>): Promise<void> {
    const file = path.join(projectsDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  }

  it("returns undefined when the Claude session file does not exist", () => {
    const seed = readFallbackSeed();
    expect(seed).toBeUndefined();
  });

  it("collects valid turns through the HOME-resolved session store despite null rows", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "first user prompt" },
      },
      null,
      {
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "first assistant reply" }],
        },
      },
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "second user prompt" },
      },
    ]);

    const seed = await readFallbackSeedFromHome();
    const fallbackSeed = requireFallbackSeed(seed, "uncompacted session");
    expect(fallbackSeed.summaryText).toBeUndefined();
    expect(fallbackSeed.recentTurns).toHaveLength(3);
    expectRecordFields(fallbackSeed.recentTurns[0], "fields", { role: "user" });
    expectRecordFields(fallbackSeed.recentTurns[2], "fields", { role: "user" });
  });

  it("preserves reseed envelopes in fallback model context", async () => {
    const reseedPrompt = buildLegacyReseedPrompt();
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: reseedPrompt },
      },
    ]);

    const seed = requireFallbackSeed(readFallbackSeed(), "reseed session");

    expectRecordFields(seed.recentTurns[0], "fields", { role: "user", content: reseedPrompt });
  });

  it("uses the explicit /compact summary and drops pre-boundary turns", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-pre",
        message: { role: "user", content: "pre-compact user turn excluded from seed" },
      },
      {
        type: "assistant",
        uuid: "a-pre",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "PRE-COMPACT assistant turn" }],
        },
      },
      {
        type: "summary",
        summary: "User asked about deployment; agent recommended a blue-green strategy.",
        leafUuid: "a-pre",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 12345 },
      },
      {
        type: "user",
        uuid: "u-post",
        message: { role: "user", content: "POST-COMPACT user follow-up" },
      },
      {
        type: "assistant",
        uuid: "a-post",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "POST-COMPACT assistant reply" }],
        },
      },
    ]);

    const seed = readFallbackSeed();
    const fallbackSeed = requireFallbackSeed(seed, "compacted session");
    expect(fallbackSeed.summaryText).toBe(
      "User asked about deployment; agent recommended a blue-green strategy.",
    );
    expect(fallbackSeed.recentTurns).toHaveLength(2);
    const recentText = JSON.stringify(fallbackSeed.recentTurns);
    expect(recentText).toContain("POST-COMPACT user follow-up");
    expect(recentText).toContain("POST-COMPACT assistant reply");
    expect(recentText).not.toContain("PRE-COMPACT");
  });

  it("falls back to compact_boundary content when no explicit summary entry is present", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-pre",
        message: { role: "user", content: "early turn" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 50000 },
      },
      {
        type: "user",
        uuid: "u-post",
        message: { role: "user", content: "post-boundary user turn" },
      },
    ]);

    const seed = readFallbackSeed();
    const fallbackSeed = requireFallbackSeed(seed, "compact boundary session");
    // Falls back to the boundary's content so the seed at least labels
    // that compaction happened, instead of replaying nothing.
    expect(fallbackSeed.summaryText).toBe("Conversation compacted");
    expect(fallbackSeed.recentTurns).toHaveLength(1);
    expect(JSON.stringify(fallbackSeed.recentTurns)).toContain("post-boundary user turn");
  });

  it("prefers the most recent summary when the session has been compacted multiple times", async () => {
    await writeJsonl([
      {
        type: "summary",
        summary: "EARLY summary that should be superseded.",
        leafUuid: "x",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "user",
        uuid: "u-mid",
        message: { role: "user", content: "mid-window turn" },
      },
      {
        type: "summary",
        summary: "LATER summary that must win.",
        leafUuid: "y",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 2000 },
      },
      {
        type: "user",
        uuid: "u-tail",
        message: { role: "user", content: "tail turn" },
      },
    ]);

    const seed = readFallbackSeed();
    expect(seed?.summaryText).toBe("LATER summary that must win.");
    expect(seed?.recentTurns).toHaveLength(1);
    expect(JSON.stringify(seed?.recentTurns)).toContain("tail turn");
    expect(JSON.stringify(seed?.recentTurns)).not.toContain("mid-window turn");
  });

  it("returns undefined when the session file is empty or has no usable content", async () => {
    await writeJsonl([
      // Sidechain entries are filtered out by the underlying parser.
      {
        type: "user",
        uuid: "u-side",
        isSidechain: true,
        message: { role: "user", content: "sidechain user turn" },
      },
    ]);
    const seed = readFallbackSeed();
    expect(seed).toBeUndefined();
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", () => {
    const seed = readFallbackSeed("../escape");
    expect(seed).toBeUndefined();
  });

  it("falls back to the latest boundary content when a newer compaction has no summary", async () => {
    await writeJsonl([
      { type: "summary", summary: "FIRST compact summary", leafUuid: "x" },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted (1)",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "user",
        uuid: "u-mid",
        message: { role: "user", content: "post-first-compact turn" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted (2)",
        compactMetadata: { trigger: "auto", preTokens: 2000 },
      },
      {
        type: "user",
        uuid: "u-tail",
        message: { role: "user", content: "post-second-compact turn" },
      },
    ]);

    const seed = readFallbackSeed();
    const fallbackSeed = requireFallbackSeed(seed, "latest boundary session");
    expect(fallbackSeed.summaryText).toBe("Conversation compacted (2)");
    expect(fallbackSeed.summaryText).not.toBe("FIRST compact summary");
    expect(fallbackSeed.recentTurns).toHaveLength(1);
    expect(JSON.stringify(fallbackSeed.recentTurns)).toContain("post-second-compact turn");
  });

  it("uses a trailing summary that has no following compact_boundary marker", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "earlier turn" },
      },
      { type: "summary", summary: "trailing summary without boundary", leafUuid: "x" },
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "later turn" },
      },
    ]);

    const seed = readFallbackSeed();
    expect(seed?.summaryText).toBe("trailing summary without boundary");
  });
});
