import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../packages/markdown-core/src/image-spans.js", () => {
  throw new Error("Display projection must not load the Markdown image scanner");
});

const visibleText = [
  "Visible reply",
  "![chart](https://example.test/chart.png)",
  "```text",
  "MEDIA:./example.png",
  "```",
].join("\n");
const text = `${visibleText}\nMEDIA:./managed.png`;

describe("display media without Markdown image scanning", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("projects history media while preserving Markdown images and fenced directives", async () => {
    const { projectChatDisplayMessages } = await import("./chat-display-projection.js");

    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: text,
          openclawDelivery: { mediaUrls: ["./managed.png"] },
        },
      ]),
    ).toMatchObject([{ content: visibleText }]);
  });

  it("withholds a live relative media tail without consuming Markdown images", async () => {
    const { normalizeLiveAssistantBufferedText } = await import("./live-chat-projector.js");

    expect(normalizeLiveAssistantBufferedText(text)).toBe(`${visibleText}\n`);
  });

  it("renders public text with its own Markdown renderer after stripping media directives", async () => {
    const { renderPublicSessionDocument } = await import("./control-ui-public-session-render.js");

    const html = renderPublicSessionDocument({
      messages: [{ role: "assistant", content: text }],
      title: "Shared conversation",
      truncated: false,
      latestUrl: "/share/session?token=synthetic",
      cardUrl: "https://example.test/share/card.png",
    });
    expect(html).toContain("Visible reply");
    expect(html).toContain("[Image omitted]");
    expect(html).toContain("MEDIA:./example.png");
    expect(html).not.toContain("managed.png");
  });
});
