import MarkdownIt from "markdown-it";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapWebContent } from "../../../../src/security/external-content.js";
import type { MessageGroup } from "./chat-types.ts";
import { extractChatSourcePreviews } from "./source-previews.ts";
import { extractToolCardsCached } from "./tool-cards.ts";

afterEach(() => vi.restoreAllMocks());

const runId = "run-sources";
const pageUrl = "https://example.com/article";
const secondUrl = "https://second.example/research";
const wrap = (text: string, source: "Web Search" | "Web Fetch" = "Web Search") =>
  wrapWebContent(text, source === "Web Search" ? "web_search" : "web_fetch");

function result(url = pageUrl) {
  return { url, title: wrap("Article title"), snippet: wrap("Search provider description.") };
}

function search(rows = [result()]) {
  return {
    kind: "results",
    provider: "example",
    query: "research",
    count: rows.length,
    results: rows,
    externalContent: { untrusted: true, source: "web_search", wrapped: true, provider: "example" },
  };
}

function tool(details: unknown, name = "web_search", id = "search-call") {
  return {
    role: "toolResult",
    toolName: name,
    toolCallId: id,
    runId,
    details,
    content: [{ type: "text", text: JSON.stringify(details) }],
  };
}

function answer(content = `[Article](${pageUrl})`) {
  return { role: "assistant", runId, phase: "final_answer", content };
}

function group(messages: unknown[], owner = runId): MessageGroup {
  return {
    kind: "group",
    key: `group-${owner}`,
    role: "assistant",
    runId: owner,
    timestamp: 1,
    isStreaming: false,
    visibleContent: "text",
    messages: messages.map((message, index) => ({
      message,
      key: `message-${index}`,
      hasVisibleContent: true,
    })),
  };
}

function previews(
  messages: unknown[],
  final: unknown = answer(),
  options: { basePath?: string; sessionPublicOrigin?: string } = {},
) {
  return extractChatSourcePreviews({
    groups: [group([...messages, final])],
    answer: final,
    runId,
    ...options,
  });
}

function fetched() {
  return {
    url: pageUrl,
    finalUrl: secondUrl,
    status: 200,
    title: wrap("Fetched title", "Web Fetch"),
    text: wrap(
      "# Page title\n\n[Home](/)\n\nThis is the readable article paragraph retained from the fetched page, with enough detail to preview its contents.",
      "Web Fetch",
    ),
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
  };
}

describe("chat source previews", () => {
  it("omits dedicated-card links before the cap without hiding ordinary GitHub or external pages", () => {
    const excluded = [
      ...Array.from(
        { length: 8 },
        (_, index) => `https://github.com/example/repo/issues/${index + 1}`,
      ),
      "https://github.com/example/repo/pull/9#discussion",
      `${location.origin}/control/chat/main/research`,
      "https://gateway.example/control/chat/main/research",
    ];
    const retained = [
      "https://github.com/example/repo",
      "https://github.com/example/repo/blob/main/README.md",
      "https://github.example/example/repo/issues/1",
      "https://docs.example/control/chat/main/research",
      `${location.origin}/control/docs/guide`,
      pageUrl,
    ];
    const links = [...excluded, ...retained];
    expect(
      previews(
        [tool(search(links.map((url) => result(url))))],
        answer(links.map((url) => `[source](${url})`).join(" ")),
        { basePath: "/control", sessionPublicOrigin: "https://gateway.example" },
      ).map((source) => source.url),
    ).toEqual(retained);
  });

  it.each(["https://github.com/example/repo/pull/12", `${location.origin}/chat/main/research`])(
    "omits a redirect to a dedicated-card destination: %s",
    (url) => {
      expect(previews([tool({ ...fetched(), finalUrl: url }, "web_fetch")])).toEqual([]);
      expect(
        previews(
          [tool({ ...fetched(), url, finalUrl: pageUrl }, "web_fetch")],
          answer(`[source](${url})`),
        ),
      ).toEqual([]);
    },
  );

  it("invalidates source classification when the Gateway origin or base path changes", () => {
    const url = "https://gateway.example/control/chat/main/research";
    const message = tool(search([result(url)]));
    const final = answer(`[source](${url})`);
    const original = previews([message], final, { basePath: "/control" });
    expect(original).toHaveLength(1);
    expect(previews([message], final, { basePath: "/control" })).toBe(original);
    expect(
      previews([message], final, {
        basePath: "/control",
        sessionPublicOrigin: "https://gateway.example",
      }),
    ).toEqual([]);
    expect(
      previews([message], final, {
        basePath: "/different",
        sessionPublicOrigin: "https://gateway.example",
      }),
    ).toHaveLength(1);
  });

  it("selects cited results in answer order using Markdown links and labels search descriptions", () => {
    const final = answer(
      `[Second][ref]\n\n[First](${pageUrl}#section) and [again](${pageUrl})\n\n[ref]: ${secondUrl}`,
    );
    expect(
      previews(
        [tool(search([result(), result(secondUrl), result("https://unused.example/")]))],
        final,
      ),
    ).toEqual([
      {
        url: secondUrl,
        title: "Article title",
        domain: "second.example",
        excerpt: "Search provider description.",
        excerptKind: "search",
      },
      {
        url: pageUrl,
        title: "Article title",
        domain: "example.com",
        excerpt: "Search provider description.",
        excerptKind: "search",
      },
    ]);
    expect(
      previews(
        [tool(search())],
        answer(`\`[code](${pageUrl})\`\n\n\`\`\`md\n[also code](${pageUrl})\n\`\`\``),
      ),
    ).toEqual([]);
  });

  it("reads standalone JSON result text and completed inline tool results", () => {
    const payload = search();
    const standalone = { ...tool(payload), details: undefined };
    const inline = {
      role: "assistant",
      runId,
      content: [
        { type: "toolcall", id: "inline", name: "web_search", arguments: { query: "research" } },
        { type: "toolresult", id: "inline", name: "web_search", details: payload },
      ],
    };
    expect(previews([standalone])).toEqual(previews([inline]));
    expect(previews([inline])).toHaveLength(1);
    expect(
      previews([
        { ...inline, __openclawToolStreamLive: true, __openclawToolStreamResultReceived: false },
      ]),
    ).toEqual([]);
  });

  it("prefers a page excerpt and matches an observed redirect without repeating the source", () => {
    const final = answer(`[Original](${pageUrl}) and [redirect](${secondUrl}#details)`);
    const payload = fetched();
    payload.text += "\n\n[Showing truncated web_fetch content. Full output: /private/temp.txt.]";
    expect(previews([tool(search()), tool(payload, "web_fetch", "fetch-call")], final)).toEqual([
      {
        url: secondUrl,
        title: "Fetched title",
        domain: "second.example",
        excerptKind: "page",
        excerpt:
          "This is the readable article paragraph retained from the fetched page, with enough detail to preview its contents.",
      },
    ]);
    expect(previews([tool(fetched(), "web_fetch")], answer(`${pageUrl}?different=1`))).toEqual([]);
  });

  it("does not use other runs, missing owners, later results, or assistant-written source JSON", () => {
    const final = answer();
    const payload = search();
    const other = { ...tool(payload), runId: "other-run" };
    expect(
      previews(
        [
          other,
          { ...tool(payload), runId: undefined },
          { role: "assistant", runId, content: JSON.stringify(payload) },
        ],
        final,
      ),
    ).toEqual([]);
    expect(
      extractChatSourcePreviews({
        groups: [group([tool(payload)], "other-run"), group([final]), group([tool(payload)])],
        answer: final,
        runId,
      }),
    ).toEqual([]);
    expect(
      extractChatSourcePreviews({
        groups: [group([tool(payload)])],
        answer: { ...final, runId: "other-run" },
        runId,
      }),
    ).toEqual([]);
  });

  it.each([
    {
      text: "The refreshed page now contains a different and more recent description of the same research result.",
      kind: "page",
      excerpt:
        "The refreshed page now contains a different and more recent description of the same research result.",
    },
    { text: "# Heading only", kind: "search", excerpt: "Search provider description." },
  ])(
    "refreshes every redirect alias when the destination is fetched again ($kind)",
    ({ text, kind, excerpt }) => {
      const newer = {
        ...fetched(),
        url: secondUrl,
        title: wrap("Updated page title", "Web Fetch"),
        text: wrap(text, "Web Fetch"),
      };
      for (const links of [
        `[Original](${pageUrl})`,
        `[Original](${pageUrl}) and [destination](${secondUrl})`,
      ]) {
        const output = previews(
          [
            tool(search()),
            tool(fetched(), "web_fetch", "first-fetch"),
            tool(newer, "web_fetch", "new-fetch"),
          ],
          answer(links),
        );
        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({
          url: secondUrl,
          title: "Updated page title",
          excerptKind: kind,
          excerpt,
        });
      }
    },
  );

  it("keeps the previous destination separate when an original URL redirects elsewhere", () => {
    const thirdUrl = "https://third.example/research";
    const redirected = {
      ...fetched(),
      finalUrl: thirdUrl,
      title: wrap("Different destination", "Web Fetch"),
    };
    const output = previews(
      [tool(fetched(), "web_fetch", "first-fetch"), tool(redirected, "web_fetch", "new-fetch")],
      answer(`[Original](${pageUrl}) and [previous destination](${secondUrl})`),
    );
    expect(output.map(({ url, title }) => ({ url, title }))).toEqual([
      { url: thirdUrl, title: "Different destination" },
      { url: secondUrl, title: "Fetched title" },
    ]);
  });

  it("resolves observed redirect chains and retires an old redirect when its URL becomes final", () => {
    const thirdUrl = "https://third.example/research";
    const nextPage = {
      ...fetched(),
      url: secondUrl,
      finalUrl: thirdUrl,
      title: wrap("Final destination", "Web Fetch"),
    };
    const messages = [tool(fetched(), "web_fetch", "first"), tool(nextPage, "web_fetch", "second")];
    expect(previews(messages)[0]).toMatchObject({ url: thirdUrl, title: "Final destination" });
    const returnedPage = {
      ...fetched(),
      url: thirdUrl,
      finalUrl: pageUrl,
      title: wrap("Returned to origin", "Web Fetch"),
    };
    expect(previews([...messages, tool(returnedPage, "web_fetch", "third")])[0]).toMatchObject({
      url: pageUrl,
      title: "Returned to origin",
    });
  });

  it("uses canonical message identities and rejects nested run overrides", () => {
    const payload = search();
    const final = { ...answer(), runId: undefined, __openclaw: { runId } };
    const searchMessage = {
      ...tool(payload),
      runId: "ignored-transport-run",
      __openclaw: { runId },
    };
    expect(previews([searchMessage], final)).toHaveLength(1);
    const wrongBlock = {
      role: "assistant",
      runId,
      content: [
        { type: "toolcall", id: "nested", name: "web_search", arguments: {} },
        {
          type: "toolresult",
          id: "nested",
          name: "web_search",
          runId: "different",
          details: payload,
        },
      ],
    };
    expect(previews([wrongBlock])).toEqual([]);
  });

  it("rejects forged web provenance in another tool envelope or contradicted invocation", () => {
    const payload = search();
    const spoof = {
      ...tool(payload, "exec"),
      content: [{ type: "toolresult", name: "web_search", details: payload }],
    };
    const call = {
      role: "assistant",
      runId,
      content: [{ type: "toolcall", id: "search-call", name: "exec", arguments: {} }],
    };
    expect(previews([spoof])).toEqual([]);
    expect(previews([call, tool(payload)])).toEqual([]);
    expect(previews([{ ...tool(payload), role: "user" }])).toEqual([]);
  });

  it("keeps citation-only search answers without assigning generated prose to a page", () => {
    const payload = {
      ...search(),
      kind: "answer",
      results: undefined,
      content: wrap("Generated combined answer that is not a quote from the cited page."),
      citations: [{ url: pageUrl }],
    };
    expect(previews([tool(payload)])).toEqual([
      { url: pageUrl, title: "example.com", domain: "example.com" },
    ]);
    expect(previews([tool({ kind: "raw", data: search() })])).toEqual([]);
    expect(previews([{ ...tool(search()), isError: true }])).toEqual([]);
    expect(previews([tool({ ...fetched(), status: 404 }, "web_fetch")])).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "file:///private/file",
    "data:text/plain,hello",
    "https://user:secret@example.com/article",
  ])("rejects unsafe source URL %s", (url) => {
    expect(previews([tool(search([result(url)]))], answer(`[source](${url})`))).toEqual([]);
  });

  it("does not expose malformed framing or invent missing page prose", () => {
    const row = {
      ...result(),
      title: "Unwrapped title",
      snippet: wrap("Hidden snippet").replace(
        /END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]+"/u,
        'END_EXTERNAL_UNTRUSTED_CONTENT id="ffffffffffffffff"',
      ),
    };
    expect(previews([tool(search([row]))])).toEqual([
      { url: pageUrl, domain: "example.com", title: "example.com" },
    ]);
    const page = { ...fetched(), text: wrap("# Heading only\n\n[Home](/)", "Web Fetch") };
    expect(previews([tool(page, "web_fetch")])[0]?.excerpt).toBeUndefined();
  });

  it("bounds previews and excerpt text while preserving Unicode", () => {
    const longPage = fetched();
    longPage.text = wrap(
      "A useful opening paragraph with enough detail to preview the fetched document.\n\n" +
        "More article content. ".repeat(2000),
      "Web Fetch",
    );
    expect(previews([tool(longPage, "web_fetch")])[0]?.excerpt).toBe(
      "A useful opening paragraph with enough detail to preview the fetched document.",
    );
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...result(`https://example.com/page-${index}`),
      snippet: wrap("😀 ".repeat(200)),
    }));
    const output = previews(
      [tool(search(rows))],
      answer(rows.map((row) => `[source](${row.url})`).join(" ")),
    );
    expect(output).toHaveLength(8);
    expect(output[0]?.excerpt?.length).toBeLessThanOrEqual(280);
    expect(output[0]?.excerpt).toMatch(/…$/u);
    expect(output[0]?.excerpt).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it("reuses Markdown work across recreated frame wrappers and invalidates changed result facts", () => {
    const parse = vi.spyOn(MarkdownIt.prototype, "parse");
    const message = tool(search());
    const final = answer();
    const first = previews([message], final);
    const parsed = parse.mock.calls.length;
    expect(parsed).toBeGreaterThan(0);
    expect(previews([message], final)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(parsed);

    const card = extractToolCardsCached(message)[0]!;
    card.details = search([{ ...result(), snippet: wrap("Updated source description.") }]);
    expect(previews([message], final)[0]?.excerpt).toBe("Updated source description.");
    expect(parse.mock.calls.length).toBeGreaterThan(parsed);

    message.runId = "another-owner";
    expect(previews([message], final)).toEqual([]);
    message.runId = runId;
    card.runId = "another-owner";
    expect(previews([message], final)).toEqual([]);
    card.runId = runId;
    card.isError = true;
    expect(previews([message], final)).toEqual([]);
    card.isError = false;
    card.details = undefined;
    card.outputText = JSON.stringify(
      search([{ ...result(), snippet: wrap("Recovered JSON source description.") }]),
    );
    expect(previews([message], final)[0]?.excerpt).toBe("Recovered JSON source description.");
    expect(previews([], final)).toEqual([]);
    expect(previews([message], answer("A completed answer without source links."))).toEqual([]);
  });

  it("caches answers without citations and updates when live result ownership is replaced", () => {
    const parse = vi.spyOn(MarkdownIt.prototype, "parse");
    const uncited = answer("No citations in this answer.");
    previews([], uncited);
    const parsed = parse.mock.calls.length;
    previews([], uncited);
    expect(parse).toHaveBeenCalledTimes(parsed);

    const final = answer();
    const pending = {
      role: "assistant",
      runId,
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: false,
      content: [{ type: "toolcall", id: "pending", name: "web_search", arguments: {} }],
    };
    expect(previews([pending], final)).toEqual([]);
    expect(previews([tool(search(), "web_search", "pending")], final)).toHaveLength(1);
    expect(
      previews([tool(search(), "web_search", "pending")], { ...final, runId: "another-run" }),
    ).toEqual([]);
  });

  it("parses only selected cited source prose even when uncited results contain large pages", () => {
    const parse = vi.spyOn(MarkdownIt.prototype, "parse");
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...result(`https://example.com/page-${index}`),
      snippet: wrap(`Source-${index} ` + "Detailed source content. ".repeat(1_000)),
    }));
    const uncitedPage = {
      ...fetched(),
      url: "https://uncited.example/",
      finalUrl: "https://uncited.example/",
      text: wrap("UNSELECTED_PAGE ".repeat(3_000), "Web Fetch"),
    };
    const final = answer(
      rows
        .slice(4, 16)
        .map((row) => `[source](${row.url})`)
        .join(" "),
    );
    expect(previews([tool(search(rows)), tool(uncitedPage, "web_fetch")], final)).toHaveLength(8);
    const parsedProse = parse.mock.calls.map(([text]) => text);
    expect(parsedProse.some((text) => text.includes("Source-4 "))).toBe(true);
    expect(
      parsedProse.some(
        (text) =>
          text.includes("Source-0 ") ||
          text.includes("Source-12 ") ||
          text.includes("UNSELECTED_PAGE"),
      ),
    ).toBe(false);
  });
});
