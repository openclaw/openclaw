import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const fetchMock = vi.fn<typeof fetch>();

vi.mock("../../packages/terminal-core/src/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (s: string) => s,
    info: (s: string) => s,
    muted: (s: string) => s,
    command: (s: string) => s,
  },
}));

vi.mock("../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: (path: string, label: string) => `${label}${path}`,
}));

vi.mock("../cli/command-format.js", () => ({ formatCliCommand: (s: string) => s }));

const { docsSearchCommand } = await import("./docs.js");
const resultsResponse = (results: unknown) => new Response(JSON.stringify({ results }));
let runtime: ReturnType<typeof createTestRuntime>;
async function expectSearchError(query: string, reason: string, json = false) {
  await expect(docsSearchCommand([query], runtime, { json })).rejects.toThrow(
    `Docs search failed: ${reason}`,
  );
}

describe("docsSearchCommand", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    runtime = createTestRuntime();
  });

  it("calls the Cloudflare docs search API", async () => {
    fetchMock.mockResolvedValueOnce(resultsResponse([]));
    await docsSearchCommand(["plugin", "allowlist"], runtime);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = expectDefined(
      fetchMock.mock.calls[0],
      "fetchMock.mock.calls[0] test invariant",
    );
    if (!(url instanceof URL)) {
      throw new Error("expected docs search to call fetch with a URL");
    }
    expect(url.href).toBe("https://docs.openclaw.ai/api/search?q=plugin+allowlist");
    expect(init).toMatchObject({ headers: { Accept: "application/json" } });
  });

  it("limits normalized search results before rendering", async () => {
    fetchMock.mockResolvedValueOnce(
      resultsResponse([
        { title: "Invalid result without a link" },
        { title: "CLI reference", link: "https://docs.openclaw.ai/cli" },
        { title: "Plugin guide", link: "https://docs.openclaw.ai/plugins" },
      ]),
    );
    await docsSearchCommand(["openclaw"], runtime, { json: true, limit: 1 });
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      query: "openclaw",
      results: [{ title: "CLI reference", link: "https://docs.openclaw.ai/cli" }],
    });
  });

  it("emits one JSON object for the docs homepage", async () => {
    await docsSearchCommand([], runtime, { json: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      query: null,
      url: "https://docs.openclaw.ai/",
      results: [],
    });
  });

  it("rejects string results instead of reporting a successful empty search", async () => {
    fetchMock.mockResolvedValueOnce(resultsResponse("unavailable"));
    await expectSearchError(
      "gateway",
      "Docs search response is malformed: expected results array",
      true,
    );
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("reports docs search responses with invalid UTF-8 bytes as malformed", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"results":[{"title":"Plugin allow'),
      0xff,
      ...new TextEncoder().encode('list","link":"https://docs.openclaw.ai/plugins/allowlist"}]}'),
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    await expectSearchError("plugin", "Docs search response is malformed JSON");
  });

  it("renders successful results from the Cloudflare docs search API", async () => {
    fetchMock.mockResolvedValueOnce(
      resultsResponse([
        {
          title: "Plugin allowlist",
          link: "https://docs.openclaw.ai/plugins/allowlist",
          snippet: "How to configure the allowlist.",
        },
      ]),
    );
    await docsSearchCommand(["plugin", "allowlist"], runtime);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalled();
  });

  it("rejects oversized docs search responses", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        for (let i = 0; i < 10; i++) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        }
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream));
    await expectSearchError("oversized", "Docs search response exceeds 8388608 bytes");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("docs search request ownership", () => {
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
    fetchMock.mockReset();
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
    vi.stubGlobal("fetch", fetchMock);
    const pending = docsSearchCommand(["held-error"], createTestRuntime()).then(
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
      expect(result).not.toBeNull();
      if (!result || result.ok) {
        throw new Error("expected the HTTP error before capture EOF");
      }
      expect(result.error).toMatchObject({ message: "Docs search failed: HTTP 503" });
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
});
