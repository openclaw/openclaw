import { afterEach, expect, it, vi } from "vitest";
import { buildChatMarkdown, exportChatMarkdown } from "./export.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const toolCall = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } }],
};
const textBlock = (text: string, type = "output_text") => [{ type, text }];
function msg(role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { role, content, ...extra };
}
const header = "# Chat with OpenClaw\n\n";
const transcript = (messages: unknown[]) => buildChatMarkdown(messages, "OpenClaw");

it.each([
  ["empty", []],
  ["tool-only", [toolCall]],
  ["image-only", [msg("assistant", [{ type: "image", data: "synthetic-image" }])]],
  ["commentary", [msg("assistant", "Checking notes", { phase: "commentary" })]],
  ["whitespace", [msg("toolResult", " \n\t")]],
] satisfies [string, unknown[]][])("does not download %s", (_name, messages) => {
  const createObjectURL = vi.spyOn(URL, "createObjectURL");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

  expect(transcript(messages)).toBeNull();
  expect(exportChatMarkdown(messages, "OpenClaw")).toBe("empty");
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});

it("downloads one readable Markdown file for a populated transcript", async () => {
  vi.useFakeTimers();
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chat-export");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  expect(
    exportChatMarkdown(
      [
        msg("user", "What can you export?", { timestamp: 1_000 }),
        msg("assistant", "A readable conversation.", { timestamp: 2_000 }),
      ],
      "OpenClaw",
    ),
  ).toBe("downloaded");

  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  await vi.runOnlyPendingTimersAsync();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:chat-export");
  const blob = createObjectURL.mock.calls[0]![0] as Blob;
  expect(blob).toMatchObject({ type: "text/markdown" });
  const markdown = await blob.text();
  expect(markdown).toContain("# Chat with OpenClaw");
  expect(markdown).toContain("## Message");
  expect(markdown).toContain("What can you export?");
  expect(markdown).toContain("## OpenClaw");
  expect(markdown).toContain("A readable conversation.");
});

it("uses transcript speaker normalization and preserves prepared literal control text", () => {
  const markdown = transcript([
    msg("USER", "Please check the build.", {
      senderLabel: "Kai (123e4567-e89b-12d3-a456-426614174000)",
    }),
    msg("ASSISTANT", textBlock("The build passed."), {
      __openclaw: { senderName: "Build assistant" },
      timestamp: 1_000,
    }),
    { ...toolCall, timestamp: 2_000 },
    msg("tool_result", "  exit 0\n", { toolCallId: "call-1" }),
    msg("assistant", "NO_REPLY"),
  ]);

  expect(markdown).toBe(
    header +
      "## Kai\n\nPlease check the build.\n\n" +
      "## Build assistant (1970-01-01T00:00:01.000Z)\n\nThe build passed.\n\n" +
      "## Tool\n\n  exit 0\n\n\n" +
      "## OpenClaw\n\nNO_REPLY\n",
  );
});

it.each([
  ["empty envelope", msg("assistant", "Body", { toolCallId: "" }), "Tool"],
  [
    "tool in user",
    msg("user", [null, ...textBlock("Body", "text"), { type: "tool_result" }]),
    "Tool",
  ],
  ["numeric envelope", msg("assistant", "Body", { toolCallId: 0 }), "OpenClaw"],
] as const)("classifies %s", (_name, message, speaker) => {
  expect(transcript([message])).toBe(`${header}## ${speaker}\n\nBody\n`);
});

it.each(["string", "blocks", "text"])("preserves imported %s content and attribution", (shape) => {
  const body = "    indented code\n\nMEDIA:https://example.invalid/report.pdf";
  const framed =
    '<<<EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>\nSource: External\n---\n' +
    body +
    '\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>';
  const message = {
    role: "assistant",
    senderLabel: "Imported assistant (123e4567-e89b-12d3-a456-426614174000)",
    __openclaw: { idempotencyKey: "fixture-catalog:thread:message", senderName: "Other name" },
    timestamp: "1000",
    ...(shape === "text"
      ? { text: framed }
      : { content: shape === "blocks" ? textBlock(framed) : framed }),
  };
  const original = structuredClone(message);

  expect(transcript([message])).toBe(`${header}## Imported assistant\n\n${body}\n`);
  expect(message).toEqual(original);
});
