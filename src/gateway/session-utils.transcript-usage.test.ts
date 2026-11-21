import "./session-utils-provider.test-support.js";
import { afterEach, expect, test } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildSessionRowFixture } from "./session-list.test-support.js";
import type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";
import { readRecentSessionUsageFromTranscriptAsync } from "./session-transcript-usage.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { createModelDefaultsConfig } from "./session-utils.test-support.js";

afterEach(clearRuntimeConfigSnapshot);

function row(transcriptUsage: SessionTranscriptUsageSnapshot | null) {
  return buildSessionRowFixture({
    cfg: createModelDefaultsConfig({ primary: "ollama/llama3.2" }),
    key: "agent:main:usage",
    store: {},
    storePath: "/unused/sessions.json",
    entry: { sessionId: "usage", updatedAt: 1, totalTokens: 1_124_767, totalTokensFresh: false },
    transcriptUsage,
    rowContext: buildSessionListRowMetadataContext({ now: 1 }),
    lightweightListRow: true,
  });
}

test.each([
  ["available", 0],
  ["available", 40],
  ["unavailable", 0],
  [undefined, 0],
] as const)(
  "projects %s transcript usage (%s) without reviving stale totals",
  (state, totalTokens) => {
    expect(
      row({
        ...(state ? { usageReport: { state } } : {}),
        totalTokens,
        totalTokensFresh: state === "available",
        inputTokens: totalTokens,
        outputTokens: 0,
      }),
    ).toMatchObject({
      totalTokens: state === "available" ? totalTokens : undefined,
      totalTokensFresh: state === "available",
    });
  },
);

test("reads selected-agent usage when global session IDs coincide", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {}, work: {} } } });
    const targets = ["main", "work"].map((agentId) => ({
      agentId,
      sessionId: "shared-id",
      sessionKey: "global",
      storePath: state.statePath("agents", agentId, "sessions", "sessions.json"),
    }));
    for (const [index, target] of targets.entries()) {
      await replaceTranscriptEvents(target, [
        {
          type: "message",
          id: "answer",
          message: {
            role: "assistant",
            content: "done",
            usage: { input: index ? 40 : 10, output: 2 },
          },
        },
      ]);
    }
    expect(
      row(await readRecentSessionUsageFromTranscriptAsync(targets[1]!, 256 * 1024)),
    ).toMatchObject({ totalTokens: 42 });
  });
});
