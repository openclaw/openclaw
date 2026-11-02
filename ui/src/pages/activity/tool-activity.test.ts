// @vitest-environment node
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseActivityEvent, updateToolActivity, type ActivityEntry } from "./tool-activity.ts";

type ActivityEvent = Parameters<typeof updateToolActivity>[1];
function activity(
  data: ActivityEvent["data"],
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return { stream: "tool", runId: "run-1", ts: 1, receivedAt: 1, data, ...overrides };
}

function buildResultPreview(result: unknown) {
  const payload = activity({ toolCallId: "tool-1", name: "bash", phase: "result", result });
  return updateToolActivity([], payload)[0]?.outputPreview;
}

it.each([
  ["a surrogate pair at the cap", "a".repeat(1_999) + "🦞tail", "a".repeat(1_999)],
  ["a lone surrogate inside the cap", "\ud800" + "a".repeat(2_100), "\ud800" + "a".repeat(1_999)],
])("preserves %s", (_label, source, expected) => {
  expect(buildResultPreview({ text: source })).toBe(expected);
});

it("preserves dotted API keys in object-shaped tool results", () => {
  const secret = 'visible secret with spaces, apostrophe: don\'t, quote: "keep hidden"';
  const preview = buildResultPreview({
    "app.api.key": secret,
    "server.port": 8080,
  });
  expect(JSON.parse(preview ?? "")["app.api.key"]).toBe(secret);
  expect(preview).toContain('"server.port": 8080');
});
it("releases large tool payloads while retaining their previews", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
            import { setImmediate as yieldTurn } from "node:timers/promises";
            import { updateToolActivity } from ${JSON.stringify(new URL("./tool-activity.ts", import.meta.url).href)};
            let entries = [];
            async function heapUsed() {
              await yieldTurn();
              globalThis.gc();
              await yieldTurn();
              globalThis.gc();
              return process.memoryUsage().heapUsed;
            }
            function append(index, size) {
              const payload = "x".repeat(2_000) + "!".repeat(size - 2_000);
              const text = JSON.parse(JSON.stringify("Synthetic " + index + ": " + payload));
              entries = updateToolActivity(entries, {
                stream: "tool",
                runId: "run-" + index, ts: index, receivedAt: index,
                data: { toolCallId: "tool-" + index, name: "read", phase: "result", result: { text } },
              });
            }
            append(0, 5_000);
            entries = [];
            const before = await heapUsed();
            for (let index = 0; index < 64; index++) append(index, 512 * 1024);
            const retainedBytes = (await heapUsed()) - before;
            // Serialize only after measuring: consuming a slice can flatten it.
            process.stdout.write(JSON.stringify({ retainedBytes, previews: entries.map((entry) => ({ text: entry.outputPreview, truncated: entry.outputTruncated })) }));
          `,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as {
    retainedBytes: number;
    previews: { text: string; truncated: boolean }[];
  };
  expect(output.previews).toEqual(
    Array.from({ length: 64 }, (_, index) => ({
      text: (`Synthetic ${index}: ` + "x".repeat(2_000)).slice(0, 2_000),
      truncated: true,
    })),
  );
  // The discarded source bodies total 32 MiB; previews need only 128 KiB.
  expect(output.retainedBytes).toBeLessThan(8 * 1024 * 1024);
}, 30_000);
it("retains the latest 100 tool entries without mutating earlier snapshots", () => {
  const event = (index: number, done = false) =>
    activity(
      { toolCallId: String(index), name: "read", phase: done ? "result" : "start" },
      { runId: "bounded-run", receivedAt: done ? 2 : 1 },
    );
  let entries: ActivityEntry[] = [];
  for (let index = 0; index < 100; index++) {
    entries = updateToolActivity(entries, event(index));
  }
  const previous = structuredClone(entries);
  const updated = updateToolActivity(entries, event(0, true));
  expect(entries).toEqual(previous);
  expect(updated[0]).toMatchObject({
    toolCallId: "0",
    status: "done",
    startedAt: 1,
    updatedAt: 2,
  });
  expect(updated.slice(1)).toEqual(previous.slice(1));
  const full = structuredClone(updated);
  const overflow = updateToolActivity(updated, event(100));
  expect(updated).toEqual(full);
  expect(overflow.map((entry) => entry.toolCallId)).toEqual(
    Array.from({ length: 100 }, (_, index) => String(index + 1)),
  );
});
it("replaces candidate text when the same item becomes authoritative", () => {
  const candidate = (status: "candidate" | "selected", progressText: string, receivedAt: number) =>
    activity(
      { kind: "answer_candidate", itemId: "answer-1", status, progressText },
      { stream: "item", ts: 10, receivedAt },
    );
  const entries = updateToolActivity(
    updateToolActivity([], candidate("candidate", "First draft", 10)),
    candidate("selected", "Final answer", 20),
  );
  expect(entries).toMatchObject([
    {
      id: "run-1:answer_candidate:answer-1",
      entryKind: "answer_candidate",
      itemId: "answer-1",
      candidateStatus: "selected",
      status: "done",
      outputPreview: "Final answer",
    },
  ]);
});

it("ignores unrelated item events", () => {
  expect(
    parseActivityEvent(activity({ kind: "preamble", itemId: "note-1" }, { stream: "item" }), 10),
  ).toBeNull();
});
