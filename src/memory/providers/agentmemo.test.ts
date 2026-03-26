import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { mockPublicPinnedHostname } from "../test-helpers/ssrf.js";

let AgentMemoSearchManager: typeof import("./agentmemo.js").AgentMemoSearchManager;
let createAgentMemoSearchManager: typeof import("./agentmemo.js").createAgentMemoSearchManager;

beforeEach(async () => {
  vi.resetModules();
  ({ AgentMemoSearchManager, createAgentMemoSearchManager } = await import("./agentmemo.js"));
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(mock: FetchMock) {
  const withPreconnect = withFetchPreconnect(mock);
  vi.stubGlobal("fetch", withPreconnect);
  mockPublicPinnedHostname();
  return withPreconnect;
}

describe("AgentMemoSearchManager", () => {
  describe("search()", () => {
    it("maps response fields to MemorySearchResult", async () => {
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  id: "note-1",
                  content: "hello world",
                  score: 0.95,
                  metadata: {
                    source: "journal",
                    path: "notes/hello.md",
                    start_line: 3,
                    end_line: 10,
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({ url: "http://example.com:8790" });
      const results = await mgr.search("hello");

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        path: "note-1",
        snippet: "hello world",
        score: 0.95,
        citation: "journal",
        startLine: 3,
        endLine: 10,
        source: "memory",
      });
    });

    it("falls back to data[] when results[] is absent", async () => {
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "d1",
                  text: "fallback text",
                  similarity: 0.8,
                  metadata: {},
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({});
      const results = await mgr.search("test");

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        path: "d1",
        snippet: "fallback text",
        score: 0.8,
      });
    });

    it("sends POST with correct body and headers", async () => {
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({
        url: "http://example.com:8790",
        apiKey: "test-key",
        namespace: "myns",
      });
      await mgr.search("query", { maxResults: 3, minScore: 0.5 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://example.com:8790/search");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        query: "query",
        namespace: "myns",
        limit: 3,
        min_score: 0.5,
      });
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });
  });

  describe("readFile()", () => {
    it("encodes path and slices lines (1-based)", async () => {
      const content = "line1\nline2\nline3\nline4\nline5";
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ content }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({ url: "http://example.com:8790" });
      const result = await mgr.readFile({ relPath: "path/to file.md", from: 2, lines: 2 });

      expect(result.text).toBe("line2\nline3");
      expect(result.path).toBe("path/to file.md");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(encodeURIComponent("path/to file.md"));
    });

    it("returns empty text on 404", async () => {
      const fetchMock = vi.fn<FetchMock>(async () => new Response("not found", { status: 404 }));
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({});
      const result = await mgr.readFile({ relPath: "missing.md" });

      expect(result.text).toBe("");
      expect(result.path).toBe("missing.md");
    });

    it("defaults from to 1 (returns all lines) when not specified", async () => {
      const content = "a\nb\nc";
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ content }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({});
      const result = await mgr.readFile({ relPath: "file.md" });

      expect(result.text).toBe("a\nb\nc");
    });
  });

  describe("probeEmbeddingAvailability()", () => {
    it("returns ok: true when health endpoint is reachable", async () => {
      const fetchMock = vi.fn<FetchMock>(async () => new Response("ok", { status: 200 }));
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({});
      const probe = await mgr.probeEmbeddingAvailability();

      expect(probe).toEqual({ ok: true });
    });

    it("returns ok: false with error message on failure", async () => {
      const fetchMock = vi.fn<FetchMock>(async () => {
        throw new Error("connection refused");
      });
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({});
      const probe = await mgr.probeEmbeddingAvailability();

      expect(probe.ok).toBe(false);
      expect(probe.error).toContain("connection refused");
    });
  });

  describe("buildHeaders()", () => {
    it("includes Content-Type only when withBody is true", async () => {
      // Test via search (withBody=true) vs readFile (withBody=false)
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({ apiKey: "k1" });

      // search sends withBody=true
      await mgr.search("q");
      const searchHeaders = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
        string,
        string
      >;
      expect(searchHeaders["Content-Type"]).toBe("application/json");
      expect(searchHeaders["Authorization"]).toBe("Bearer k1");

      // readFile sends withBody=false (GET)
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ content: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await mgr.readFile({ relPath: "x" });
      const readHeaders = (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers as Record<
        string,
        string
      >;
      expect(readHeaders["Content-Type"]).toBeUndefined();
      expect(readHeaders["Authorization"]).toBe("Bearer k1");
    });

    it("omits Authorization when apiKey is not set", async () => {
      const fetchMock = vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      stubFetch(fetchMock);

      const mgr = new AgentMemoSearchManager({});
      await mgr.search("q");

      const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
        string,
        string
      >;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["Accept"]).toBe("application/json");
    });
  });

  describe("status()", () => {
    it("returns correct backend and provider", () => {
      const mgr = new AgentMemoSearchManager({
        url: "http://my-server:9000",
        namespace: "test-ns",
      });
      const s = mgr.status();

      expect(s.backend).toBe("agentmemo");
      expect(s.provider).toBe("agentmemo");
      expect(s.model).toBe("external");
      expect(s.custom).toMatchObject({
        url: "http://my-server:9000",
        namespace: "test-ns",
      });
    });

    it("uses defaults when no config provided", () => {
      const mgr = new AgentMemoSearchManager({});
      const s = mgr.status();

      expect(s.custom).toMatchObject({
        url: "http://localhost:8790",
        namespace: "openclaw",
      });
    });
  });

  describe("createAgentMemoSearchManager()", () => {
    it("returns an AgentMemoSearchManager instance", () => {
      const mgr = createAgentMemoSearchManager({ url: "http://localhost:1234" });
      expect(mgr).toBeInstanceOf(AgentMemoSearchManager);
    });
  });
});
