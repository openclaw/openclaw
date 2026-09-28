import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function createTool(stateDir: string) {
  return createTranscriptsTool({ config: { transcripts: { enabled: true } }, stateDir });
}

describe("transcripts tool imports", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("imports a speaker transcript and writes summary artifacts", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const result = await createTool(stateDir).execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "design-review",
        title: "Design review",
        transcript:
          "Alex: We decided to ship Discord first.\nSam: Action item: add Slack import later.",
      },
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      details: { sessionId: "design-review", utteranceCount: 2 },
    });
    const store = storeFor(stateDir);
    const stored = await store.readSession("design-review");
    expect(stored).toBeDefined();
    const sessionDir = store.sessionDir(stored!);
    await expect(fs.readFile(path.join(sessionDir, "summary.md"), "utf8")).resolves.toContain(
      "Sam: Action item: add Slack import later.",
    );
    await expect(fs.readFile(path.join(sessionDir, "summary.json"), "utf8")).resolves.toContain(
      '"Alex: We decided to ship Discord first."',
    );
    await expect(store.readUtterancesForSession(stored!)).resolves.toEqual([
      expect.objectContaining({ text: "We decided to ship Discord first." }),
      expect.objectContaining({ text: "Action item: add Slack import later." }),
    ]);
  });

  it("bounds summary input while retaining the full transcript", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const transcript = Array.from(
      { length: 2_001 },
      (_, index) => `Alex: transcript line ${index}`,
    ).join("\n");

    await createTool(stateDir).execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "long-meeting",
        title: "Long meeting",
        transcript,
      },
      undefined,
      vi.fn(),
    );

    const store = storeFor(stateDir);
    const stored = await store.readSession("long-meeting");
    expect(stored).toBeDefined();
    const summary = await fs.readFile(path.join(store.sessionDir(stored!), "summary.md"), "utf8");
    expect(summary).not.toContain("transcript line 0\n");
    expect(summary).toContain("transcript line 2000");
    const storedTranscript = await store.readUtterancesForSession(stored!);
    expect(storedTranscript[0]?.text).toContain("transcript line 0");
    expect(storedTranscript.at(-1)?.text).toContain("transcript line 2000");
  });
});
