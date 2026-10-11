/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolFixture as render } from "./chat-tool-render.test-support.ts";

describe("tool-card source fidelity", () => {
  it.each([
    ["/Users/alice/Pictures/base.png", "~/Pictures/base.png"],
    ["D:\\Users\\alice\\Pictures\\base.png", "~\\Pictures\\base.png"],
    ["/var/folders/demo/screenshots/base.png", "/var/folders/demo/screenshots/base.png"],
  ])("keeps image path %s readable in the tool row", async (path, expected) => {
    const container = document.createElement("div");
    await render(
      renderToolCard(
        { id: "msg:image", name: "view_image", args: { path } },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector("[role=img]")?.ariaLabel).toBe("view_image");
    expect(container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(expected);
  });

  const publicUrl = "https://x.com/EliXPampa/status/2097727549400871286";
  const secret = "Ab9Q".repeat(10);
  const numericSlashSecret = "1234/" + "Ab9Q".repeat(8) + "Ab9";

  it.each([
    ["long URL hostname", `https://${secret}.example.test`, `https://${secret}.example.test`],
    [
      "numeric URL port",
      `https://example.test:8080/path-${secret}`,
      `https://example.test:8080/path-${secret}`,
    ],
    [
      "base64 payload with key-shaped suffix",
      `data:application/octet-stream;base64,AAAA/${secret}@`,
      `data:application/octet-stream;base64,AAAA/${secret}@`,
    ],
    ["URL fragment", `https://example.test/#${secret}`, `https://example.test/#${secret}`],
    [
      "adjacent Markdown label",
      `https://example.test/[${secret}](target)`,
      `https://example.test/[${secret}](target)`,
    ],
    [
      "at-sign beyond query cutoff",
      `https://example.test/path-${secret}?foo=@`,
      `https://example.test/path-${secret}?foo=@`,
    ],
    [
      "path ending in a version",
      `https://example.test/${secret}@latest`,
      `https://example.test/${secret}@latest`,
    ],
    [
      "compact URLs after a query",
      JSON.stringify([`${publicUrl}?safe=1`, publicUrl]),
      JSON.stringify([`${publicUrl}?safe=1`, publicUrl]),
    ],
    [
      "URL in parenthesized query value",
      `https://example.test/?next=(https://example.test/path-${secret})`,
      `https://example.test/?next=(https://example.test/path-${secret})`,
    ],
    [
      "userinfo before punctuation",
      `https://name-${secret})@example.test`,
      `https://name-${secret})@example.test`,
    ],
    [
      "s3 numeric slash password",
      `s3://user:${numericSlashSecret}@bucket`,
      `s3://user:${numericSlashSecret}@bucket`,
    ],
    ["credential after URL", `${publicUrl} ${secret}`, `${publicUrl} ${secret}`],
    [
      "credential query",
      `https://example.test/?access_token=${secret}`,
      `https://example.test/?access_token=${secret}`,
    ],
  ])("renderToolCard preserves %s", async (_label, input, expected) => {
    const container = document.createElement("div");
    await render(
      renderToolCard(
        { id: "msg:redaction", name: "custom_tool", args: { message: input } },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );
    expect(container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(expected);
  });
});
