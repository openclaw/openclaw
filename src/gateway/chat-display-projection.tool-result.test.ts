import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.js";

const hostTab = { targetId: "tab-1", target: "host", profile: "work" };
const nodeTab = { ...hostTab, target: "node", node: "node-1" };

describe("chat display tool-result detail projection", () => {
  it.each([
    [
      {
        ...hostTab,
        url: "https://example.com",
        title: "Example",
        extra: "drop",
      },
      {
        ...hostTab,
        url: "https://example.com",
        title: "Example",
      },
    ],
    [
      {
        targetId: "x".repeat(128),
        target: "node",
        profile: "p".repeat(128),
        node: "n".repeat(256),
        url: "u".repeat(2047) + "😀",
        title: "t".repeat(511) + "😀",
      },
      {
        targetId: "x".repeat(128),
        target: "node",
        profile: "p".repeat(128),
        node: "n".repeat(256),
        url: "u".repeat(2047),
        title: "t".repeat(511),
      },
    ],
    [{ ...hostTab, url: 42, title: [] }, hostTab],
    ...[
      null,
      [],
      "tab-1",
      { ...hostTab, target: "sandbox" },
      { ...hostTab, target: "node" },
      { ...hostTab, node: "node-1" },
      ...[1, "", " padded "].map((targetId) => Object.assign({}, nodeTab, { targetId })),
      ...["targetId", "profile", "node"].flatMap((key) =>
        [undefined, "x".repeat(key === "node" ? 257 : 129)].map((value) =>
          Object.assign({}, nodeTab, { [key]: value }),
        ),
      ),
    ].map((invalid) => [invalid, undefined] as const),
  ] as const)(
    "projects only bounded browser tab descriptor fields (%j)",
    (browserTab, expected) => {
      const result = { type: "toolResult", toolName: "browser", details: { browserTab } };
      const [standalone, nested] = sanitizeChatHistoryMessages([
        { role: "toolResult", ...result },
        { role: "assistant", content: [result] },
      ]) as Array<Record<string, unknown>>;
      const block = (nested?.content as Array<Record<string, unknown>> | undefined)?.[0];
      for (const projected of [standalone, block]) {
        expect(projected?.details).toEqual(expected ? { browserTab: expected } : undefined);
      }
    },
  );

  it("omits opaque provider replay state from display history", () => {
    const [message] = sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }],
        providerReplay: {
          type: "openai-responses-compaction",
          data: "opaque-display-compaction",
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
    expect(message).not.toHaveProperty("providerReplay");
    expect(JSON.stringify(message)).not.toContain("opaque-display-compaction");
  });

  it("keeps authoritative write booleans and strips unrelated details", () => {
    const [overwrite, created, invalid] = sanitizeChatHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "write-1",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: false, diff: "-1 old\n+1 new", private: "drop" },
      },
      {
        role: "toolResult",
        toolCallId: "write-2",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: true },
      },
      {
        role: "toolResult",
        toolCallId: "write-3",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: "true", created: 1 },
      },
    ]) as Array<Record<string, unknown>>;

    expect(overwrite?.details).toEqual({
      changed: true,
      created: false,
      diff: "-1 old\n+1 new",
    });
    expect(created?.details).toEqual({ changed: true, created: true });
    expect(invalid).not.toHaveProperty("details");
  });
});

describe("bounded tool output previews", () => {
  it("caps nested output once, preserves literal text, and removes private media", () => {
    const text = " \n[[reply_to_current]] <tag>\r\n" + "x".repeat(20_000) + "  \n";
    const message = {
      role: "assistant",
      __openclaw: {
        id: "nested-output",
        toolOutput: { source: "execution", modelInput: "unverified" },
      },
      content: [
        {
          type: "toolResult",
          toolCallId: "nested-call",
          toolName: "exec",
          isError: true,
          text,
          content: [
            { type: "text", text },
            { type: "image", data: "PRIVATE_IMAGE", path: "/private/image.png" },
          ],
        },
      ],
    };
    const original = structuredClone(message);
    const [preview] = sanitizeChatHistoryMessages([message], 32) as Array<Record<string, unknown>>;
    expect(preview).toMatchObject({
      __openclaw: { ...message["__openclaw"], truncated: true, reason: "display-cap" },
      content: [
        {
          type: "toolResult",
          toolCallId: "nested-call",
          toolName: "exec",
          isError: true,
          content: [
            { type: "text", text: text.slice(0, 32) },
            { type: "image", omitted: true },
          ],
        },
      ],
    });
    const [block] = preview!.content as Array<Record<string, unknown>>;
    expect(block).not.toHaveProperty("text");
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_IMAGE");
    expect(JSON.stringify(preview)).not.toContain("/private/image.png");
    expect(message).toEqual(original);
  });

  it.each(["toolResult", "tool_result", "tool", "function"])(
    "keeps %s output whitespace and UTF-16 intact without adding a truncation sentinel",
    (role) => {
      const [preview] = sanitizeChatHistoryMessages([{ role, content: " \n😀  \n" }], 3) as Array<
        Record<string, unknown>
      >;
      expect(preview).toMatchObject({
        content: " \n",
        __openclaw: { truncated: true, reason: "display-cap" },
      });
    },
  );
});
