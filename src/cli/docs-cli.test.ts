import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { registerDocsCli } from "./docs-cli.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));
const fetchMock = vi.fn<typeof fetch>();

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtime,
}));

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

vi.mock("../../packages/terminal-core/src/links.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/links.js")>()),
  formatDocsLink: (path: string, label: string) => `${label}${path}`,
}));

async function search(query: string[], options: { json?: boolean; limit?: number } = {}) {
  const program = new Command().name("openclaw").exitOverride();
  registerDocsCli(program);
  const argv = [
    "node",
    "openclaw",
    "docs",
    ...query,
    ...(options.json ? ["--json"] : []),
    ...(options.limit !== undefined ? ["--limit", String(options.limit)] : []),
  ];
  const previousArgv = process.argv;
  process.argv = argv;
  try {
    await program.parseAsync(argv);
  } finally {
    process.argv = previousArgv;
  }
}
const respond = (results: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results })));
const loggedJson = () => JSON.parse(String(runtime.log.mock.calls[0]?.[0]));

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(isRich).mockReturnValue(false);
  vi.stubGlobal("fetch", fetchMock);
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

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
  ["null root", "null", "malformed: expected results array"],
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
  await expect(search(["oversized"], { json: true })).rejects.toThrow(
    "Docs search failed: Docs search response exceeds 8388608 bytes",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([503, 200])("settles a retained HTTP %i body on error or interruption", async (status) => {
  const scope = new AsyncWorkScope();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let requestSignal: AbortSignal | null | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const response = new Response(source, { status });
  const capture = response.clone();
  fetchMock.mockImplementation(async (_url, init) => {
    requestSignal = init?.signal;
    requestSignal?.addEventListener(
      "abort",
      () => streamController?.error(new DOMException("fixture aborted", "AbortError")),
      { once: true },
    );
    if (status === 200) {
      scope.beginClose();
    }
    return response;
  });
  vi.useFakeTimers();
  const settled = vi.fn();
  const pending = scope
    .run(() => search(["held-error"], { json: true }))
    .then(() => settled(), settled);
  try {
    await vi.advanceTimersByTimeAsync(0);
    const message = status === 503 ? "Docs search failed: HTTP 503" : undefined;
    expect(settled.mock.calls).toEqual(message ? [[expect.objectContaining({ message })]] : [[]]);
    expect(requestSignal?.aborted).toBe(true);
    expect(runtime.log).not.toHaveBeenCalled();
  } finally {
    streamController?.error(new DOMException("fixture cleanup", "AbortError"));
    await capture.body?.cancel().catch(() => undefined);
    await pending;
    vi.useRealTimers();
  }
});
