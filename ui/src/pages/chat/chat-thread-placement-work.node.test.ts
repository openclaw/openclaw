// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { message, nativeMessage, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { createRunTurnLookup } from "./chat-thread-run-identity.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";
import * as causalBoundary from "./stream-causal-boundary.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetChatThreadState();
});

it("does not repeat history placement scans for sibling live tools", () => {
  const scans = vi.spyOn(causalBoundary, "knownStreamCausalInterval");
  const measure = (count: number) => {
    scans.mockClear();
    const groups = buildCachedChatItems(
      createProps({
        runId: "live-run",
        messages: [message("user", "Earlier prompt", 1), message("assistant", "Earlier reply", 2)],
        toolMessages: Array.from({ length: count }, (_, index) =>
          toolResult(`live-${index}`, "shell", `Result ${index}`, index + 3, {
            runId: "live-run",
          }),
        ),
      }),
    ).filter((item) => item.kind === "group");
    const cards = groups.flatMap((group) =>
      group.messages.flatMap(({ message: source }) => extractToolCardsCached(source)),
    );
    expect(cards).toHaveLength(count);
    return scans.mock.calls.length;
  };
  const single = measure(1);
  expect(single).toBeGreaterThan(0);
  expect(measure(50)).toBe(single);
});

it("shares causal placement only for the same run and input within one snapshot", () => {
  const scans = vi.spyOn(causalBoundary, "knownStreamCausalInterval");
  const row = (key: string, role: string, metadata: object): ChatItem => ({
    kind: "message",
    key,
    message: nativeMessage(role, key, 1, metadata),
  });
  const items = [
    row("prompt-a", "user", { idempotencyKey: "input-a:user" }),
    row("output-a", "assistant", { runId: "run-a" }),
    row("prompt-b", "user", { idempotencyKey: "input-b:user" }),
    row("output-b", "assistant", { runId: "run-b" }),
    row("prompt-next", "user", { idempotencyKey: "input-next:user" }),
  ];
  const lookup = createRunTurnLookup(items);
  const cases = [
    { runId: "run-a", expected: { afterKey: "prompt-a", beforeKey: "prompt-b" } },
    { runId: "missing", expected: null },
    { runId: "run-b", expected: { afterKey: "prompt-b", beforeKey: "prompt-next" } },
    {
      runId: "missing",
      afterUserSendId: "paged-input",
      expected: { afterKey: undefined, beforeKey: "prompt-a" },
    },
  ];
  for (let round = 0; round < 3; round++) {
    for (const entry of cases) {
      expect(lookup(entry.runId, entry.afterUserSendId)).toEqual(entry.expected);
    }
  }
  expect(scans).toHaveBeenCalledTimes(cases.length);

  const refreshed = createRunTurnLookup([
    ...items,
    row("arrived-output", "assistant", { runId: "missing" }),
  ]);
  expect(refreshed("missing")).toEqual({ afterKey: "prompt-next", beforeKey: undefined });
  expect(refreshed("missing")).toEqual({ afterKey: "prompt-next", beforeKey: undefined });
  expect(scans).toHaveBeenCalledTimes(cases.length + 1);
});
