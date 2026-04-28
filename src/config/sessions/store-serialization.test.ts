import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry, SessionSystemPromptReport } from "./types.js";

function createSystemPromptReport(): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: 1,
    bootstrapTruncation: {
      warningMode: "once",
      warningSignaturesSeen: ["sig-a", "sig-b"],
    },
    systemPrompt: {
      chars: 123_456,
      projectContextChars: 120_000,
      nonProjectContextChars: 3_456,
    },
    injectedWorkspaceFiles: [
      {
        name: "large.md",
        path: "/workspace/large.md",
        missing: false,
        rawChars: 50_000,
        injectedChars: 40_000,
        truncated: true,
      },
    ],
    skills: {
      promptChars: 80_000,
      entries: [{ name: "report-only-skill", blockChars: 80_000 }],
    },
    tools: {
      listChars: 10_000,
      schemaChars: 90_000,
      entries: [
        {
          name: "large_tool",
          summaryChars: 1_000,
          schemaChars: 90_000,
          propertiesCount: 200,
        },
      ],
    },
  };
}

function createEntry(index: number): SessionEntry {
  return {
    sessionId: `session-${index}`,
    updatedAt: 1_700_000_000_000 + index,
    skillsSnapshot: {
      prompt: `STATIC_SKILLS_PROMPT_${"x".repeat(5_000)}`,
      skills: [{ name: "field-research" }],
      version: 7,
    },
    systemPromptReport: createSystemPromptReport(),
  };
}

describe("session store serialization", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "session-store-serialization-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    clearSessionStoreCacheForTest();
    await suiteRootTracker.cleanup();
  });

  it("omits repeated static skills prompts and prompt report detail arrays when persisting many rows", async () => {
    const testDir = await suiteRootTracker.make("many-static-payloads");
    const storePath = path.join(testDir, "sessions.json");
    const store = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`agent:main:${index}`, createEntry(index)]),
    );

    await saveSessionStore(storePath, store);

    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("STATIC_SKILLS_PROMPT_");
    expect(raw).not.toContain("large.md");
    expect(raw).not.toContain("report-only-skill");
    expect(raw).not.toContain("large_tool");

    const persisted = JSON.parse(raw) as Record<string, SessionEntry>;
    for (const entry of Object.values(persisted)) {
      expect(entry.skillsSnapshot).toMatchObject({
        prompt: "",
        promptOmitted: true,
        version: 7,
      });
      expect(entry.systemPromptReport).toMatchObject({
        detailsOmitted: true,
        bootstrapTruncation: {
          warningMode: "once",
          warningSignaturesSeen: ["sig-a", "sig-b"],
        },
        systemPrompt: {
          chars: 123_456,
        },
        skills: {
          promptChars: 80_000,
          entries: [],
        },
        tools: {
          schemaChars: 90_000,
          entries: [],
        },
      });
    }
  });

  it("loads legacy rows that still contain full static payloads", async () => {
    const testDir = await suiteRootTracker.make("legacy-static-payloads");
    const storePath = path.join(testDir, "sessions.json");
    const legacyEntry = createEntry(1);
    await fs.writeFile(
      storePath,
      JSON.stringify({ "agent:main:legacy": legacyEntry }, null, 2),
      "utf8",
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded["agent:main:legacy"].skillsSnapshot?.prompt).toContain("STATIC_SKILLS_PROMPT_");
    expect(loaded["agent:main:legacy"].systemPromptReport?.injectedWorkspaceFiles).toHaveLength(1);
    expect(loaded["agent:main:legacy"].systemPromptReport?.tools.entries).toHaveLength(1);
  });
});
