import { beforeEach, expect, it, vi } from "vitest";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const fetchMock = vi.fn<typeof fetch>();

vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  return {
    ...actual,
    isRich: vi.fn(() => false),
    theme: {
      ...actual.theme,
      heading: (s: string) => s,
      info: (s: string) => s,
      muted: (s: string) => s,
      command: (s: string) => s,
    },
  };
});

vi.mock("../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: (path: string, label: string) => `${label}${path}`,
}));

const { docsSearchCommand } = await import("./docs.js");
let runtime: ReturnType<typeof createTestRuntime>;
const search = (query: string[], options: Parameters<typeof docsSearchCommand>[2] = {}) =>
  docsSearchCommand(query, runtime, options);
const respond = (results: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results })));
const loggedJson = () => JSON.parse(String(runtime.log.mock.calls[0]?.[0]));

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(isRich).mockReturnValue(false);
  vi.stubGlobal("fetch", fetchMock);
  runtime = createTestRuntime();
});

it("calls the Cloudflare docs search API", async () => {
  respond([]);
  await search(["plugin", "allowlist"]);

  expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(URL);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ href: "https://docs.openclaw.ai/api/search?q=plugin+allowlist" }),
    expect.objectContaining({ headers: { Accept: "application/json" } }),
  );
  expect(runtime.log.mock.calls).toEqual([["# Docs search: plugin allowlist\n\n_No results._"]]);
});

it("limits normalized search results before rendering", async () => {
  respond([
    { title: "Invalid result without a link" },
    { title: "CLI reference", link: "https://docs.openclaw.ai/cli" },
    { title: "Plugin guide", link: "https://docs.openclaw.ai/plugins" },
  ]);
  await search(["openclaw"], { json: true, limit: 1 });
  expect(loggedJson()).toEqual({
    query: "openclaw",
    results: [{ title: "CLI reference", link: "https://docs.openclaw.ai/cli" }],
  });
});

it("emits one JSON object for the docs homepage", async () => {
  await search([], { json: true });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(loggedJson()).toEqual({
    query: null,
    url: "https://docs.openclaw.ai/",
    results: [],
  });
});

it.each([
  [
    "non-array results",
    JSON.stringify({ results: "unavailable" }),
    "malformed: expected results array",
  ],
  [
    "invalid UTF-8",
    Buffer.from('{"results":[{"title":"\xff","link":"/"}]}', "latin1"),
    "malformed JSON",
  ],
] as const)(
  "rejects %s without reporting a successful empty search",
  async (_name, body, error) => {
    fetchMock.mockResolvedValueOnce(new Response(body));
    await expect(search(["gateway"], { json: true })).rejects.toThrow(
      `Docs search failed: Docs search response is ${error}`,
    );
    expect(runtime.log).not.toHaveBeenCalled();
  },
);

it.each([
  {
    rich: false,
    output: [
      "# Docs search: plugin \\[allowlist\\]\n\n- [Plugin \\[allowlist\\]](https://docs.openclaw.ai/plugins/allowlist) - How to \\(configure\\).",
    ],
  },
  {
    rich: true,
    output: [
      "Docs search: plugin [allowlist]",
      "- Plugin [allowlist] (docs.openclaw.ai/plugins/allowlisthttps://docs.openclaw.ai/plugins/allowlist)",
      "  How to (configure).",
    ],
  },
])("renders search results with rich=$rich", async ({ rich, output }) => {
  vi.mocked(isRich).mockReturnValue(rich);
  respond([
    {
      title: "Plugin [allowlist]",
      link: "https://docs.openclaw.ai/plugins/allowlist",
      snippet: "How to (configure).",
    },
  ]);
  await search(["plugin", "[allowlist]"]);

  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(runtime.log.mock.calls).toEqual(output.map((line) => [line]));
});

it("rejects oversized docs search responses", async () => {
  const ONE_MIB = 1024 * 1024;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    cancel,
    start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(new Uint8Array(ONE_MIB));
      }
      controller.close();
    },
  });
  fetchMock.mockResolvedValueOnce(new Response(stream));
  await expect(search(["oversized"])).rejects.toThrow(
    "Docs search failed: Docs search response exceeds 8388608 bytes",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it("settles a known HTTP error before a retained clone reaches EOF", async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let requestSignal: AbortSignal | null | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode("held response"));
    },
  });
  const response = new Response(source, { status: 503 });
  const capture = response.clone();
  fetchMock.mockImplementation(async (_url, init) => {
    requestSignal = init?.signal;
    requestSignal?.addEventListener(
      "abort",
      () => {
        streamController?.error(new DOMException("fixture aborted", "AbortError"));
      },
      { once: true },
    );
    return response;
  });
  const pending = search(["held-error"]).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 500);
      }),
    ]);
    expect(result).toMatchObject({ ok: false, error: { message: "Docs search failed: HTTP 503" } });
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    if (deadline) {
      clearTimeout(deadline);
    }
    streamController?.error(new DOMException("fixture cleanup", "AbortError"));
    await capture.body?.cancel().catch(() => undefined);
    await pending;
    vi.unstubAllGlobals();
  }
});
