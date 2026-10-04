/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";

describe("tool-card redaction", () => {
  it.each([
    ["/Users/alice/Pictures/base.png", "~/Pictures/base.png"],
    ["/home/alice/Pictures/base.png", "~/Pictures/base.png"],
    ["D:\\Users\\alice\\Pictures\\base.png", "~\\Pictures\\base.png"],
    ["/var/folders/demo/screenshots/base.png", "/var/folders/demo/screenshots/base.png"],
    ["D:\\screenshots\\base.png", "D:\\screenshots\\base.png"],
  ])("keeps image path %s readable in the tool row", (path, expected) => {
    const container = document.createElement("div");
    render(
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
  const masked = "Ab9QAb...Ab9Q";

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
    ["URL fragment", `https://example.test/#${secret}`, `https://example.test/#${masked}`],
    [
      "adjacent Markdown label",
      `https://example.test/[${secret}](target)`,
      `https://example.test/[${masked}](target)`,
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
      `https://example.test/?next=(https://example.test/path-${masked})`,
    ],
    [
      "userinfo before punctuation",
      `https://name-${secret})@example.test`,
      `https://name-${masked})@example.test`,
    ],
    [
      "s3 numeric slash password",
      `s3://user:${numericSlashSecret}@bucket`,
      "s3://user:1234/A...QAb9@bucket",
    ],
    ["credential after URL", `${publicUrl} ${secret}`, `${publicUrl} ${masked}`],
    [
      "credential query",
      `https://example.test/?access_token=${secret}`,
      `https://example.test/?access_token=${masked}`,
    ],
  ])(
    "renderToolCard displays the %s with public URLs intact and credentials masked",
    (_label, input, expected) => {
      const container = document.createElement("div");
      render(
        renderToolCard(
          { id: "msg:redaction", name: "custom_tool", args: { message: input } },
          { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
        ),
        container,
      );

      expect(container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(expected);
    },
  );
});
