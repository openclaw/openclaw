import MarkdownIt from "markdown-it";
import { afterEach, expect, it, vi } from "vitest";
import { wrapWebContent } from "../../../../src/security/external-content.js";
import type { MessageGroup } from "./chat-types.ts";
import { extractChatSourcePreviews } from "./source-previews.ts";

afterEach(() => vi.restoreAllMocks());

const runId = "run-sources";
const pageUrl = "https://example.com/article";
const secondUrl = "https://second.example/research";
const wrap = (text: string, source: "Web Search" | "Web Fetch" = "Web Search") =>
  wrapWebContent(text, source === "Web Search" ? "web_search" : "web_fetch");
const description = "Search provider description.";
const result = (url = pageUrl) => ({
  url,
  title: wrap("Article title"),
  snippet: wrap(description),
});
const expectedSource = (url: string, fields = {}) => ({
  url,
  title: "Article title",
  domain: new URL(url).hostname,
  excerpt: description,
  excerptKind: "search",
  ...fields,
});
const externalContent = (source: string) => ({ untrusted: true, source, wrapped: true });
const search = (results = [result()]) => ({
  kind: "results",
  results,
  externalContent: externalContent("web_search"),
});
const tool = (details: unknown = search(), name = "web_search", id = "search-call") => ({
  role: "toolResult",
  toolName: name,
  toolCallId: id,
  runId,
  details,
  content: [{ type: "text", text: JSON.stringify(details) }],
});
const assistant = (content: unknown) => ({ role: "assistant", runId, content });
const searchTool = (rows = [result()]) => tool(search(rows));
const bareSource = { url: pageUrl, title: "example.com", domain: "example.com" };
const answer = (content = `[Article](${pageUrl})`) => ({
  ...assistant(content),
  phase: "final_answer",
});
const linksAnswer = (urls: string[]) => answer(urls.map((url) => `[source](${url})`).join(" "));
const call = (id: string, name = "web_search") => ({ type: "toolcall", id, name, arguments: {} });
const inline = (details: unknown = search(), extra = {}) =>
  assistant([
    call("inline"),
    { type: "toolresult", id: "inline", name: "web_search", details, ...extra },
  ]);
const live = { __openclawToolStreamLive: true, __openclawToolStreamResultReceived: false };
const controlPath = { basePath: "/control" };
const gateway = { ...controlPath, sessionPublicOrigin: "https://gateway.example" };
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
const previews = (
  messages: unknown[],
  final: unknown = answer(),
  options: { basePath?: string; sessionPublicOrigin?: string } = {},
) =>
  extractChatSourcePreviews({
    groups: [group([...messages, final])],
    answer: final,
    runId,
    ...options,
  });
const framed = (groups: MessageGroup[], final: unknown) =>
  extractChatSourcePreviews({ groups, answer: final, runId });

const none = (messages: unknown[], final: unknown = answer()) =>
  expect(previews(messages, final)).toEqual([]);

const pageExcerpt =
  "This is the readable article paragraph retained from the fetched page, with enough detail to preview its contents.";
const fetched = (text = `# Page title\n\n[Home](/)\n\n${pageExcerpt}`, status = 200) => ({
  url: pageUrl,
  finalUrl: secondUrl,
  status,
  title: wrap("Fetched title", "Web Fetch"),
  text: wrap(text, "Web Fetch"),
  externalContent: externalContent("web_fetch"),
});
const fetchTool = (payload = fetched()) => tool(payload, "web_fetch", "fetch-call");

it("omits dedicated-card links before the cap without hiding ordinary GitHub or external pages", () => {
  const repo = "https://github.com/example/repo";
  const excluded = [
    ...Array.from({ length: 8 }, (_, index) => `${repo}/issues/${index + 1}`),
    `${repo}/pull/9#discussion`,
    `${location.origin}/control/chat/main/research`,
    "https://gateway.example/control/chat/main/research",
  ];
  const retained = [
    repo,
    `${repo}/blob/main/README.md`,
    "https://github.example/example/repo/issues/1",
    "https://docs.example/control/chat/main/research",
    `${location.origin}/control/docs/guide`,
    pageUrl,
  ];
  const links = [...excluded, ...retained];
  expect(
    previews([searchTool(links.map(result))], linksAnswer(links), gateway).map(
      (source) => source.url,
    ),
  ).toEqual(retained);
});

it("invalidates source classification when the Gateway origin or base path changes", () => {
  const url = "https://gateway.example/control/chat/main/research";
  const message = searchTool([result(url)]);
  const final = linksAnswer([url]);
  const original = previews([message], final, controlPath);
  expect(original).toHaveLength(1);
  expect(previews([message], final, controlPath)).toBe(original);
  expect(previews([message], final, gateway)).toEqual([]);
  expect(previews([message], final, { ...gateway, basePath: "/different" })).toHaveLength(1);
});

it("selects cited results in answer order using Markdown links and labels search descriptions", () => {
  const final = answer(
    `[Second][ref]\n\n[First](${pageUrl}#section) and [again](${pageUrl})\n\n[ref]: ${secondUrl}`,
  );
  const message = searchTool([result(), result(secondUrl), result("https://unused.example/")]);
  expect(previews([message], final)).toEqual([expectedSource(secondUrl), expectedSource(pageUrl)]);
  none(
    [searchTool()],
    answer(`\`[code](${pageUrl})\`\n\n\`\`\`md\n[also code](${pageUrl})\n\`\`\``),
  );
});

it("reads standalone JSON result text and completed inline tool results", () => {
  const standalone = { ...tool(), details: undefined };
  const completed = inline();
  expect(previews([standalone])).toEqual(previews([completed]));
  expect(previews([completed])).toHaveLength(1);
  none([{ ...completed, ...live }]);
});

it("prefers a page excerpt and matches an observed redirect without repeating the source", () => {
  const final = answer(`[Original](${pageUrl}) and [redirect](${secondUrl}#details)`);
  const payload = fetched();
  payload.text += "\n\n[Showing truncated web_fetch content. Full output: /private/temp.txt.]";
  expect(previews([searchTool(), fetchTool(payload)], final)).toEqual([
    expectedSource(secondUrl, {
      title: "Fetched title",
      excerptKind: "page",
      excerpt: pageExcerpt,
    }),
  ]);
  none([fetchTool()], answer(`${pageUrl}?different=1`));
});

it("does not use other runs, missing owners, later results, or assistant-written source JSON", () => {
  const final = answer();
  const other = { ...tool(), runId: "other-run" };
  const unowned = { ...tool(), runId: undefined };
  none([other, unowned, assistant(JSON.stringify(search()))], final);
  expect(framed([group([tool()], "other-run"), group([final]), group([tool()])], final)).toEqual(
    [],
  );
  expect(framed([group([tool()])], { ...final, runId: "other-run" })).toEqual([]);
});

it("uses canonical message identities and rejects nested run overrides", () => {
  const final = { ...answer(), runId: undefined, __openclaw: { runId } };
  const searchMessage = { ...tool(), runId: "ignored-transport-run", __openclaw: { runId } };
  expect(previews([searchMessage], final)).toHaveLength(1);
  none([inline(undefined, { runId: "different" })]);
});

it("rejects forged web provenance in another tool envelope or contradicted invocation", () => {
  const payload = search();
  const spoof = {
    ...tool(payload, "exec"),
    content: [{ type: "toolresult", name: "web_search", details: payload }],
  };
  none([spoof]);
  none([assistant([call("search-call", "exec")]), tool(payload)]);
  none([{ ...tool(payload), role: "user" }]);
});

it("keeps citation-only search answers without assigning generated prose to a page", () => {
  const payload = {
    ...search(),
    kind: "answer",
    results: undefined,
    content: wrap("Generated combined answer that is not a quote from the cited page."),
    citations: [{ url: pageUrl }],
  };
  expect(previews([tool(payload)])).toEqual([bareSource]);
  none([tool({ kind: "raw", data: search() })]);
  none([{ ...searchTool(), isError: true }]);
  none([fetchTool(fetched(undefined, 404))]);
});

it.each(["javascript:alert(1)", "https://user:secret@example.com/article"])(
  "rejects unsafe source URL %s",
  (url) => {
    none([searchTool([result(url)])], linksAnswer([url]));
  },
);

it("does not expose malformed framing or invent missing page prose", () => {
  const row = {
    ...result(),
    title: "Unwrapped title",
    snippet: wrap("Hidden snippet").replace(
      /END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]+"/u,
      'END_EXTERNAL_UNTRUSTED_CONTENT id="ffffffffffffffff"',
    ),
  };
  expect(previews([searchTool([row])])).toEqual([bareSource]);
  expect(previews([fetchTool(fetched("# Heading only\n\n[Home](/)"))])[0]?.excerpt).toBeUndefined();
});

it("bounds previews and excerpt text while preserving Unicode", () => {
  const longPage = fetched(
    "# Heading\n\n" +
      "> A quoted paragraph with enough detail but nested outside the main page prose.\n\n" +
      "Short navigation.\n\n" +
      "A useful **opening paragraph** with enough detail to preview the fetched document.\n\n" +
      "More article content. ".repeat(2000),
  );
  expect(previews([fetchTool(longPage)])[0]?.excerpt).toBe(
    "A useful opening paragraph with enough detail to preview the fetched document.",
  );
  const rows = Array.from({ length: 20 }, (_, index) => ({
    ...result(`https://example.com/page-${index}`),
    snippet: wrap("😀 ".repeat(200)),
  }));
  const output = previews([searchTool(rows)], linksAnswer(rows.map((row) => row.url)));
  expect(output).toHaveLength(8);
  expect(output[0]?.excerpt?.length).toBeLessThanOrEqual(280);
  expect(output[0]?.excerpt).toMatch(/…$/u);
  expect(output[0]?.excerpt).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
});

it("reuses Markdown work across recreated frame wrappers", () => {
  const parse = vi.spyOn(MarkdownIt.prototype, "parse");
  const message = searchTool();
  const final = answer();
  const first = previews([message], final);
  const parsed = parse.mock.calls.length;
  expect(parsed).toBeGreaterThan(0);
  expect(previews([message], final)).toBe(first);
  expect(parse).toHaveBeenCalledTimes(parsed);

  none([], final);
  none([message], answer("A completed answer without source links."));
});

it("caches answers without citations and updates when live result ownership is replaced", () => {
  const parse = vi.spyOn(MarkdownIt.prototype, "parse");
  const uncited = answer("No citations in this answer.");
  previews([], uncited);
  const parsed = parse.mock.calls.length;
  previews([], uncited);
  expect(parse).toHaveBeenCalledTimes(parsed);

  const final = answer();
  const pending = { ...assistant([call("pending")]), ...live };
  none([pending], final);
  expect(previews([tool(search(), "web_search", "pending")], final)).toHaveLength(1);
  none([tool(search(), "web_search", "pending")], { ...final, runId: "another-run" });
});
