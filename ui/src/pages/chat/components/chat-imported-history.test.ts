import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import {
  catalogDisplayFacts,
  catalogItemTextPrefix,
  projectCatalogItemForDisplay,
  projectImportedMessageForDisplay,
  projectPreservedCatalogMessageForDisplay,
} from "../../../../../src/chat/session-catalog-display.js";
import { wrapExternalContent } from "../../../../../src/security/external-content.js";
import { i18n } from "../../../i18n/index.ts";
import {
  prepareChatMessageRender,
  resolveMessageDisplayMarkdown,
} from "../../../lib/chat/message-display.ts";
import { extractText, extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { coalesceToolActivityMessages } from "../chat-tool-activity-coalesce.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { MessageActions, resolveMessageActionDetails } from "./chat-message-markdown-view.tsx";
import { ChatToolOutput } from "./chat-tool-output-view.tsx";

const importKey = "example-catalog:thread:item";
const wrap = (text: string) =>
  wrapExternalContent(text, { source: "unknown", includeWarning: false }).trim();
const container = document.createElement("div");
let root: ReturnType<typeof mountSolid> | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
});

function displayed(message: unknown) {
  return resolveMessageDisplayMarkdown(message, normalizeMessage(message));
}
const imported = (content: string, role = "assistant") => ({
  role,
  content,
  __openclaw: { idempotencyKey: importKey },
});
function expectDisplay(message: unknown, text: string) {
  expect(extractText(message)).toBe(text);
  expect(displayed(message)).toBe(text);
}

it("localizes catalog truncation in retained browse/import views and the open output panel", async () => {
  const messages = [
    {
      id: "tool",
      type: "toolResult" as const,
      toolName: "bash",
      toolCallId: "tool",
      text: "literal [Output truncated]\n" + "x".repeat(600),
      isError: false,
      exitCode: 0,
      truncated: true,
    },
    { id: "reasoning", type: "reasoning" as const, text: "", truncated: true },
    { id: "answer", type: "agentMessage" as const, text: "Partial answer", truncated: true },
  ].flatMap((item) => {
    const projected: unknown[] = [projectCatalogItemForDisplay(item)];
    projected.push(
      ...projectPreservedCatalogMessageForDisplay({
        role: "assistant",
        content: [{ type: "text", text: catalogItemTextPrefix(item.type) + wrap(item.text) }],
        __openclaw: { catalogDisplay: catalogDisplayFacts(item) },
      }),
    );
    if (item.type !== "toolResult") {
      return projected;
    }
    // The call owns the grouped row; only its separate result is truncated.
    return projected.flatMap((message, index) =>
      coalesceToolActivityMessages([
        {
          kind: "message",
          key: `call-${index}`,
          message: projectCatalogItemForDisplay({
            type: "toolCall",
            toolName: "bash",
            toolCallId: "tool",
            toolInput: { command: "check" },
          }),
        },
        { kind: "message", key: `result-${index}`, message },
      ]).flatMap((row) => (row.kind === "message" ? [row.message] : [])),
    );
  });
  const original = structuredClone(messages);
  const card = extractToolCardsCached(messages[0])[0];
  if (!card) {
    throw new Error("Missing catalog tool card");
  }
  root = mountSolid(
    () => [
      ...messages.map((message, index) =>
        createComponent(GroupedMessage, {
          preparation: prepareChatMessageRender(message),
          messageKey: `catalog-${index}`,
          options: {
            isStreaming: false,
            showReasoning: true,
            isToolMessageExpanded: () => true,
            isToolExpanded: () => true,
          },
        }),
      ),
      createComponent(ChatToolOutput, { content: { kind: "tool-output", card } }),
    ],
    { container },
  );
  try {
    for (const [locale, notice] of [
      ["fr", "[Sortie tronquée]"],
      ["de", "[Ausgabe gekürzt]"],
      ["en", "[Output truncated]"],
    ] as const) {
      await i18n.setLocale(locale);
      await vi.waitFor(() =>
        expect(
          Array.from(container.querySelectorAll('p[role="status"]'), (node) => node.textContent),
        ).toEqual(Array(7).fill(notice)),
      );
      expect(container.querySelectorAll(".chat-thinking")).toHaveLength(2);
      expect(container.querySelector(".chat-tool-output__text")?.textContent).toContain(
        "literal [Output truncated]",
      );
      expect(messages).toEqual(original);
    }
  } finally {
    await i18n.setLocale("en");
  }
});

it.each(["user", "assistant"])(
  "projects imported %s content shapes without changing history",
  (role) => {
    const body = "A **message**\n\n---\n\nSource: External\n\n~~~ts\nconst answer = 42;\n~~~";
    const wrapped = wrap(body);
    for (const shape of [
      { text: wrapped },
      { content: wrapped },
      { content: [{ type: "text", text: wrapped }] },
    ]) {
      const message = { role, ...shape, __openclaw: { idempotencyKey: importKey } };
      const original = structuredClone(message);
      expectDisplay(message, body);
      expect(extractTextCached(message)).toBe(body);
      expect(message).toEqual(original);
    }
    expectDisplay(
      {
        role,
        idempotencyKey: importKey,
        content: [
          { type: "text", text: wrap("First") },
          null,
          { type: role === "user" ? "input_text" : "output_text", text: wrap("Second") },
        ],
      },
      "First\nSecond",
    );
  },
);

it.each(["user", "assistant"])("renders imported %s Markdown for reply and copy", async (role) => {
  const body = "Imported **answer**\n\n~~~ts\nconst answer = 42;\n~~~";
  const message = imported(wrap(body), role);
  root = mountSolid(
    () =>
      createComponent(GroupedMessage, {
        preparation: prepareChatMessageRender(message),
        messageKey: "imported",
        options: { isStreaming: false, showReasoning: false },
      }),
    { container },
  );
  expect(container.querySelector(".chat-text strong")?.textContent).toBe("answer");
  expect(container.querySelector("pre code")?.textContent?.trimEnd()).toBe("const answer = 42;");
  expect(container.textContent).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
  expect(container.textContent).not.toContain("Source: External");
  expect(container.querySelector("h2")).toBeNull();
  const onReply = vi.fn();
  const details = resolveMessageActionDetails(prepareChatMessageRender(message), {
    messageId: "imported",
    senderLabel: role,
    onReply,
  });
  expect(details?.replyTarget?.text).toBe(body);
  if (role === "assistant") {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(details?.markdown).toBe(body);
    root.unmount();
    root = mountSolid(() => createComponent(MessageActions, { details, options: { onReply } }), {
      container,
    });
    container.querySelector<HTMLButtonElement>(".chat-copy-btn")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
  }
});

it.each(["user", "assistant"])("preserves %s CRLF body whitespace", (role) => {
  const body = "  First\r\n\r\nSecond  ";
  const message = imported(wrap(body).replaceAll("\n", "\r\n").replaceAll("\r\r\n", "\r\n"), role);
  expect(projectImportedMessageForDisplay(message)).toEqual({ ...message, content: body });
  expect(normalizeMessage(message).content).toEqual(
    normalizeMessage({ role, content: body }).content,
  );
  expect(displayed(message)).toBe(role === "assistant" ? "  First\r\n\r\nSecond" : body);
});

it.each([
  ["fenced example", (text: string) => "~~~text\n" + text + "\n~~~"],
  ["inline example", (text: string) => "Example: " + text],
  ["truncated wrapper", (text: string) => text.slice(0, -10)],
  [
    "mismatched id",
    (text: string) =>
      text.replace(
        /END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]+"/,
        'END_EXTERNAL_UNTRUSTED_CONTENT id="ffffffffffffffff"',
      ),
  ],
  ["missing separator", (text: string) => text.replace("\n---\n", "\n")],
  ["extra suffix", (text: string) => text + "\nKeep this suffix"],
  ["different source", (text: string) => text.replace("Source: External", "Source: Web Fetch")],
] as const)("preserves %s literally", (_name, transform) => {
  const content = transform(wrap("Keep this body"));
  expectDisplay(imported(content), content);
});

it.each([
  ["\n", ""],
  ["\r\n", ""],
  ["Thinking\n\n\n", ""],
  ["", "\n"],
  ["", "\r\n"],
])("does not unwrap extra separators %j / %j", (prefix, suffix) => {
  const framed = wrap("Keep this body");
  const content = prefix + framed + suffix;
  const message = imported(content);
  expect(projectImportedMessageForDisplay(message)).toEqual(message);
  if (prefix) {
    expect(
      projectPreservedCatalogMessageForDisplay({
        ...message,
        __openclaw: { catalogDisplay: { type: "agentMessage" } },
      }),
    ).toMatchObject([{ content: [{ type: "text", text: content }] }]);
  }
  expect(displayed(message)).toBe(prefix.startsWith("Thinking") ? content : framed);
  expect(extractText(message)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
});

it.each([
  [
    "warning",
    wrapExternalContent("Evidence", { source: "unknown" }).trim(),
    { idempotencyKey: importKey },
  ],
  ["no provenance", wrap("A literal wrapper example"), {}],
  ["ordinary provenance", wrap("A literal wrapper example"), { idempotencyKey: "ordinary:user" }],
] as const)("preserves %s framing", (_name, content, metadata) => {
  expectDisplay({ role: "assistant", content, __openclaw: metadata }, content);
});

it("strips only the outer frame, retaining nested examples", () => {
  const body = "~~~text\n" + wrap("Literal nested example") + "\n~~~";
  expectDisplay(imported(wrap("BODY").replace("BODY", body)), body);
});

it.each(["Thinking", "Tool call", "Tool result", "Other"])("keeps imported %s labels", (prefix) => {
  expectDisplay(imported(prefix + "\n\n" + wrap("Original text")), prefix + "\n\nOriginal text");
});

it("does not hide security framing in tool output", () => {
  const content = wrap("Tool evidence");
  expect(extractText(imported(content, "toolResult"))).toBe(content);
});
