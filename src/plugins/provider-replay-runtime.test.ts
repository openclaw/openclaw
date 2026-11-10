import { beforeEach, expect, it, vi } from "vitest";
import { buildSessionContext } from "../../packages/agent-core/src/harness/session/session.js";
import type { SessionTreeEntry } from "../../packages/agent-core/src/harness/types.js";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { limitHistoryTurns } from "../agents/embedded-agent-runner/history.js";
import { validateReplayTurns } from "../agents/embedded-agent-runner/replay-history.js";
import { resolveTranscriptPolicy } from "../agents/transcript-policy.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  sanitizeProviderReplayHistoryWithPluginAsync,
  validateProviderReplayTurnsWithPlugin,
} from "./provider-replay-runtime.js";

const { resolveProviderRuntimePlugin } = vi.hoisted(() => ({
  resolveProviderRuntimePlugin:
    vi.fn<typeof import("./provider-hook-runtime.js").resolveProviderRuntimePlugin>(),
}));
vi.mock("./provider-hook-runtime.js", () => ({ resolveProviderRuntimePlugin }));
beforeEach(() => resolveProviderRuntimePlugin.mockReset());

it("prefers the awaited replay hook and never retries failures through its legacy adapter", async () => {
  const legacy = vi.fn(() => []);
  const awaited = vi.fn(async () => {
    throw new Error("worker replay write failed");
  });
  resolveProviderRuntimePlugin.mockReturnValue({
    id: "demo",
    label: "Demo",
    auth: [],
    sanitizeReplayHistory: legacy,
    sanitizeReplayHistoryAsync: awaited,
  });
  await expect(
    sanitizeProviderReplayHistoryWithPluginAsync({
      provider: "demo",
      context: { provider: "demo", sessionId: "replay-failure", messages: [] },
    }),
  ).rejects.toThrow("worker replay write failed");
  expect(legacy).not.toHaveBeenCalled();
});

it("retains the deprecated third-party replay hook when no awaited hook is provided", async () => {
  const messages: AgentMessage[] = [{ role: "user", content: "sanitized", timestamp: 1 }];
  const legacy = vi.fn(() => messages);
  resolveProviderRuntimePlugin.mockReturnValue({
    id: "demo",
    label: "Demo",
    auth: [],
    sanitizeReplayHistory: legacy,
  });
  expect(
    await sanitizeProviderReplayHistoryWithPluginAsync({
      provider: "demo",
      context: { provider: "demo", sessionId: "replay-legacy", messages: [] },
    }),
  ).toBe(messages);
});

it.each(["sanitizeReplayHistoryAsync", "sanitizeReplayHistory", "validateReplayTurns"] as const)(
  "%s keeps nested edits on nullish returns without changing frozen source history",
  async (hookName) => {
    for (const result of [undefined, null]) {
      const source = freezeJsonSnapshot([
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "original" }],
          timestamp: 1,
        },
      ]);
      const context = {
        provider: "demo",
        sessionId: "writable-replay",
        messages: source as AgentMessage[],
      };
      resolveProviderRuntimePlugin.mockReturnValue({
        id: "demo",
        label: "Demo",
        auth: [],
        [hookName]: (input: typeof context) => {
          const message = input.messages[0];
          if (
            message?.role !== "user" ||
            !Array.isArray(message.content) ||
            message.content[0]?.type !== "text"
          ) {
            throw new Error("Expected user text fixture");
          }
          message.content[0].text = "rewritten";
          input.messages.push({ role: "user", content: "appended", timestamp: 2 });
          input.messages = [];
          return result;
        },
      });
      const invoke =
        hookName === "validateReplayTurns"
          ? validateProviderReplayTurnsWithPlugin
          : sanitizeProviderReplayHistoryWithPluginAsync;
      expect(await invoke({ provider: "demo", context })).toBe(result);
      expect(context.messages).toHaveLength(2);
      expect(context.messages[0]).toMatchObject({ content: [{ text: "rewritten" }] });
      expect(source).toHaveLength(1);
      expect(source[0]).toMatchObject({ content: [{ text: "original" }] });
    }
  },
);

it.each([sanitizeProviderReplayHistoryWithPluginAsync, validateProviderReplayTurnsWithPlugin])(
  "%s keeps source identity when no hook exists",
  async (invoke) => {
    const context = {
      provider: "demo",
      sessionId: "no-replay-hook",
      messages: freezeJsonSnapshot([] as AgentMessage[]),
    };
    const messages = context.messages;
    expect(await invoke({ provider: "demo", context })).toBeUndefined();
    expect(context.messages).toBe(messages);
  },
);

it("runs built-in turn validation on in-place edits after a nullish provider result", async () => {
  const messages: AgentMessage[] = freezeJsonSnapshot([
    { role: "user", content: "original", timestamp: 1 },
  ]);
  resolveProviderRuntimePlugin.mockReturnValue({
    id: "demo",
    label: "Demo",
    auth: [],
    validateReplayTurns: (context) => {
      context.messages.push({ role: "user", content: "appended", timestamp: 2 });
      return null;
    },
  });
  const validated = await validateReplayTurns({
    provider: "demo",
    modelApi: "anthropic-messages",
    messages,
    policy: {
      ...resolveTranscriptPolicy({ modelApi: "anthropic-messages" }),
      validateAnthropicTurns: true,
      appendOnlyRuntimeContext: false,
    },
  });
  expect(validated).toHaveLength(1);
  expect(JSON.stringify(validated)).toContain("appended");
  expect(messages).toHaveLength(1);
});

it.each(["sanitizeReplayHistoryAsync", "sanitizeReplayHistory", "validateReplayTurns"] as const)(
  "%s preserves reset-retained history when limiting three newer turns to one",
  async (hookName) => {
    const timestamp = "2026-11-09T00:00:00.000Z";
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "retained",
        parentId: null,
        timestamp,
        message: { role: "user", content: "retained before reset", timestamp: 1 },
      },
      {
        type: "reset",
        id: "reset",
        parentId: "retained",
        timestamp,
        reason: "reset",
        firstKeptEntryId: "retained",
      },
      ...[1, 2, 3].map((turn) => ({
        type: "message" as const,
        id: `new-${turn}`,
        parentId: turn === 1 ? "reset" : `new-${turn - 1}`,
        timestamp,
        message: { role: "user" as const, content: `new turn ${turn}`, timestamp: turn + 1 },
      })),
    ];
    const context = {
      provider: "demo",
      sessionId: "reset-retained",
      messages: buildSessionContext(entries).messages,
    };
    resolveProviderRuntimePlugin.mockReturnValue({
      id: "demo",
      label: "Demo",
      auth: [],
      [hookName]: (input: typeof context) => input.messages,
    });
    const invoke =
      hookName === "validateReplayTurns"
        ? validateProviderReplayTurnsWithPlugin
        : sanitizeProviderReplayHistoryWithPluginAsync;
    const replay = await invoke({ provider: "demo", context });
    expect(limitHistoryTurns(replay ?? context.messages, 1)).toEqual([
      expect.objectContaining({ content: "retained before reset" }),
      expect.objectContaining({ content: "new turn 3" }),
    ]);
  },
);
