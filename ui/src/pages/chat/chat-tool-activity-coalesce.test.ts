// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as canvas from "../../../../src/chat/canvas-render.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";

afterEach(() => vi.restoreAllMocks());

function result(id: string) {
  return { type: "tool_result", id, name: "custom", text: JSON.stringify({ exitCode: 0, id }) };
}

function item(message: Record<string, unknown>, key = "current"): ChatItem {
  return { kind: "message", key, message };
}

describe("tool activity preparation cache", () => {
  it.each(["identified", "anonymous sibling", "standalone"])(
    "prepares %s output once across rebuilds and older pages",
    (shape) => {
      const block = result("current");
      const message =
        shape === "standalone"
          ? { role: "toolResult", toolCallId: block.id, toolName: block.name, content: block.text }
          : {
              role: "assistant",
              content: [
                ...(shape === "anonymous sibling"
                  ? [{ type: "tool_call", name: "other", arguments: {} }]
                  : []),
                block,
              ],
            };
      const prepare = vi.spyOn(canvas, "extractCanvasFromText");
      const current = item(message);
      const first = coalesceToolActivityMessages([current]);
      expect(prepare.mock.calls.filter(([text]) => text === block.text)).toHaveLength(1);
      expect(coalesceToolActivityMessages([current])).toEqual(first);
      const olderBlock = result("older");
      const older = item({ role: "assistant", content: [olderBlock] }, "older");
      expect(coalesceToolActivityMessages([older, current])).toEqual([older, ...first]);
      expect(prepare.mock.calls.filter(([text]) => text === block.text)).toHaveLength(1);
      expect(prepare.mock.calls.filter(([text]) => text === olderBlock.text)).toHaveLength(1);

      coalesceToolActivityMessages([item({ ...message })]);
      expect(prepare.mock.calls.filter(([text]) => text === block.text)).toHaveLength(2);
    },
  );

  it("re-extracts a replaced block while retaining its unchanged siblings", () => {
    const block = result("changed");
    const sibling = result("sibling");
    const message = { role: "assistant", content: [block, sibling] };
    const prepare = vi.spyOn(canvas, "extractCanvasFromText");
    coalesceToolActivityMessages([item(message)]);
    message.content = [{ ...block, text: '{"exitCode":1}' }, sibling];
    coalesceToolActivityMessages([item(message)]);
    expect(prepare.mock.calls.map(([text]) => text)).toEqual([
      block.text,
      sibling.text,
      '{"exitCode":1}',
    ]);
  });
});
