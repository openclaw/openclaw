import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";

const zeroAssistant = {
  role: "assistant",
  provider: "ollama",
  model: "llama3.2",
  usage: {
    input: 0,
    output: 0,
    totalTokens: 0,
    contextUsage: { state: "available" as const, promptTokens: 0, totalTokens: 0 },
  },
};
afterEach(clearRuntimeConfigSnapshot);

it.each([
  ["sqlite", true, true],
  ["artifact", true, true],
  ["artifact", false, true],
  ["artifact", false, false],
] as const)(
  "retains measured zero context from %s transcripts (billing=%s, context=%s)",
  (source, reported, measured) => {
    const usageReport = reported ? { state: "available" } : undefined;
    const snapshot = aggregateSessionTranscriptUsage(
      [
        {
          ...zeroAssistant,
          usage: {
            ...zeroAssistant.usage,
            usageReport,
            contextUsage: measured ? zeroAssistant.usage.contextUsage : undefined,
          },
        },
      ],
      source,
    );
    expect(snapshot).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(snapshot?.totalTokens).toBe(measured ? 0 : undefined);
    expect(snapshot?.totalTokensFresh).toBe(measured ? true : undefined);
    expect(snapshot?.usageReport).toEqual(usageReport);
  },
);

it.each([321, 0, undefined])(
  "reads persisted compaction context %s without changing cumulative billing",
  (tokensAfter) =>
    withOpenClawTestState({ prefix: "compaction-usage-", applyEnv: false }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "compaction-session",
        sessionKey: "agent:main:compaction",
        storePath: path.join(state.root, "sessions.json"),
      };
      setRuntimeConfigSnapshot({});
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
        totalTokens: 410,
        totalTokensFresh: true,
      });
    }),
);
