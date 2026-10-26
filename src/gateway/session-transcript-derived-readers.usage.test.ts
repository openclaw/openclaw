import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "../plugin-sdk/session-transcript-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";

const zeroUsage = {
  input: 0,
  output: 0,
  totalTokens: 0,
  contextUsage: { state: "available" as const, promptTokens: 0, totalTokens: 0 },
};

it.each(["sqlite", "artifact"] as const)(
  "retains authoritative zero usage from %s transcripts",
  (source) => {
    const snapshot = aggregateSessionTranscriptUsage(
      [
        {
          role: "assistant",
          provider: "ollama",
          model: "llama3.2",
          usage: { ...zeroUsage, usageReport: { state: "available" } },
        },
      ],
      source,
    );
    expect(snapshot).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
      usageReport: { state: "available" },
    });
  },
);

it("does not promote legacy artifact zero counters to a fresh context measurement", () => {
  const snapshot = aggregateSessionTranscriptUsage(
    [{ role: "assistant", provider: "ollama", model: "llama3.2", usage: zeroUsage }],
    "artifact",
  );
  expect(snapshot?.totalTokens).toBeUndefined();
  expect(snapshot?.totalTokensFresh).toBeUndefined();
});

it.each([321, 0, undefined])(
  "reads persisted compaction context %s without changing cumulative billing",
  async (tokensAfter) => {
    const state = await createOpenClawTestState({ prefix: "compaction-usage-", applyEnv: false });
    const scope = {
      agentId: "main",
      sessionId: "compaction-session",
      sessionKey: "agent:main:compaction",
      storePath: path.join(state.root, "sessions.json"),
    };
    setRuntimeConfigSnapshot({});
    try {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
      const append = (eventId: string, message: Record<string, unknown>) =>
        appendSessionTranscriptMessageByIdentity({ ...scope, eventId, message });
      const identity = { provider: "openai", model: "gpt-5.6-luna" };
      const assistant = (input: number) => ({
        ...identity,
        role: "assistant",
        usage: {
          input,
          output: 10,
          contextUsage: { state: "available", promptTokens: input, totalTokens: input + 10 },
        },
      });
      await append("before", assistant(1000));
      await append("compacted", {
        ...identity,
        role: "custom",
        customType: "openclaw.context-compaction",
        usage: {
          contextUsage:
            tokensAfter === undefined
              ? { state: "unavailable" }
              : { state: "available", promptTokens: tokensAfter, totalTokens: tokensAfter },
        },
      });
      const snapshot = async () =>
        aggregateSessionTranscriptUsage(
          (await readSessionTranscriptEvents(scope)).map((event) =>
            isRecord(event) ? event.message : undefined,
          ),
          "sqlite",
        );
      const compacted = await snapshot();
      expect(compacted).toMatchObject({ inputTokens: 1000, outputTokens: 10 });
      expect(compacted?.usageReport).toBeUndefined();
      expect(compacted?.totalTokens).toBe(tokensAfter);
      expect(compacted?.totalTokensFresh).toBe(tokensAfter === undefined ? undefined : true);
      await append("after", assistant(400));
      expect(await snapshot()).toMatchObject({
        inputTokens: 1400,
        outputTokens: 20,
        totalTokens: 400,
        totalTokensFresh: true,
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      await state.cleanup();
      clearRuntimeConfigSnapshot();
    }
  },
);
