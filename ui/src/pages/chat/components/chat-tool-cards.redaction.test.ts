/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";

describe("tool-card redaction", () => {
  const publicUrl = "https://x.com/EliXPampa/status/2097727549400871286";
  const secret = "Ab9Q".repeat(10);
  const numericSlashSecret = "1234/" + "Ab9Q".repeat(8) + "Ab9";
  const masked = "Ab9QAb...Ab9Q";

  it.each([
    ["public status URL", publicUrl, publicUrl],
    ["long URL path", `https://example.test/${secret}`, `https://example.test/${secret}`],
    [
      "punctuated URL path",
      `https://example.test/path-${secret}`,
      `https://example.test/path-${secret}`,
    ],
    ["long URL hostname", `https://${secret}.example.test`, `https://${secret}.example.test`],
    [
      "at-sign in URL path",
      "https://x.com/@user/status/2097727549400871286",
      "https://x.com/@user/status/2097727549400871286",
    ],
    [
      "numeric URL port",
      `https://example.test:8080/path-${secret}`,
      `https://example.test:8080/path-${secret}`,
    ],
    [
      "key-shaped status after at-sign path",
      `https://x.com/@user/status/${secret}`,
      `https://x.com/@user/status/${secret}`,
    ],
    [
      "base64 payload with key-shaped suffix",
      `data:application/octet-stream;base64,AAAA/${secret}@`,
      `data:application/octet-stream;base64,AAAA/${secret}@`,
    ],
    ["bare credential", secret, masked],
    ["URL fragment", `https://example.test/#${secret}`, `https://example.test/#${masked}`],
    [
      "unknown URL query",
      `https://example.test/?foo=.${secret}`,
      `https://example.test/?foo=.${masked}`,
    ],
    [
      "adjacent Markdown label",
      `https://example.test/[${secret}](target)`,
      `https://example.test/[${masked}](target)`,
    ],
    [
      "adjacent parenthesis",
      `https://example.test/(${secret})`,
      `https://example.test/(${masked})`,
    ],
    ["adjacent brace", `https://example.test/{${secret}}`, `https://example.test/{${masked}}`],
    [
      "URL inside query",
      `https://example.test/?next=https://example.test/path-${secret}`,
      `https://example.test/?next=https://example.test/path-${masked}`,
    ],
    [
      "URL inside fragment",
      `https://example.test/#https://example.test/path-${secret}`,
      `https://example.test/#https://example.test/path-${masked}`,
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
    ...[")", "]", "}", "|", "\x60", "\x27", '"', "<", ">"].map((punctuation) => [
      `userinfo before ${punctuation}`,
      `https://name-${secret}${punctuation}@example.test`,
      `https://name-${masked}${punctuation}@example.test`,
    ]),
    ["s3 password", `s3://user:${secret}@bucket`, `s3://user:${masked}@bucket`],
    ["s3 username", `s3://name-${secret}:pass@bucket`, `s3://name-${masked}:pass@bucket`],
    [
      "s3 password with an at-sign",
      `s3://user:part@${secret}@bucket`,
      `s3://user:part@${masked}@bucket`,
    ],
    [
      "s3 numeric slash password",
      `s3://user:${numericSlashSecret}@bucket`,
      "s3://user:1234/A...QAb9@bucket",
    ],
    ["s3 slash-prefixed key", `s3://user:1234/${secret}@bucket`, `s3://user:1234/${masked}@bucket`],
    ["dot-prefixed credential", `.${secret}`, `.${masked}`],
    ["credential after URL", `${publicUrl} ${secret}`, `${publicUrl} ${masked}`],
    ["credential before URL", `${secret} ${publicUrl}`, `${masked} ${publicUrl}`],
    [
      "slash credential after URL",
      publicUrl + " " + "Aa0/".repeat(10),
      publicUrl + " Aa0/Aa...Aa0/",
    ],
    [
      "credential query",
      `https://example.test/?access_token=${secret}`,
      `https://example.test/?access_token=${masked}`,
    ],
    [
      "credential field",
      `{"awsSecretAccessKey":"${secret}"}`,
      `{"awsSecretAccessKey":"${masked}"}`,
    ],
    [
      "credential after Markdown link",
      `[docs](${publicUrl})${secret}`,
      `[docs](${publicUrl})${masked}`,
    ],
    [
      "credential after Markdown punctuation",
      `[docs](${publicUrl});${secret}`,
      `[docs](${publicUrl});${masked}`,
    ],
    ["credential in table", `|${publicUrl}|${secret}|`, `|${publicUrl}|${masked}|`],
  ])(
    "renderToolCard displays the %s with public URLs intact and credentials masked",
    (_label, input, expected) => {
      const container = document.createElement("div");
      render(
        renderToolCard(
          { id: "msg:redaction", name: "message", args: { message: input } },
          { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
        ),
        container,
      );

      expect(container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(expected);
    },
  );
});
