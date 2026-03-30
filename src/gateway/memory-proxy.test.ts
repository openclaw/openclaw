import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  MEMORY_PROXY_CONFIGURED_AGENTS,
  classifyMemoryOperation,
  evaluateMemoryAcl,
  handleMemoryProxyHttpRequest,
  initializeMemoryProxyAuditState,
  listConfiguredMemoryAgents,
  resolveMemoryDataset,
  resolveMemoryProxyTarget,
  resolveTrustedMemoryAgentId,
  resetMemoryProxyStateForTests,
} from "./memory-proxy.js";

const AUTH_NONE = { mode: "none", modeSource: "config" } as unknown as ResolvedGatewayAuth;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

async function startMemoryProxyServer() {
  const server = createServer((req, res) => {
    void handleMemoryProxyHttpRequest(req, res, { auth: AUTH_NONE });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get test server address");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

async function sendJsonRequest(params: {
  baseUrl: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const url = new URL(params.path, params.baseUrl);
  const payload = params.body === undefined ? undefined : JSON.stringify(params.body);
  return await new Promise<{
    status: number;
    headers: Record<string, string | string[]>;
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: params.method,
        headers: {
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...params.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function readAuditEntries(homeDir: string): Promise<Record<string, unknown>[]> {
  const path = join(homeDir, ".openclaw", "audit", "memory-access.jsonl");
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("memory-proxy", () => {
  let tempHome: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "memory-proxy-"));
    vi.stubEnv("HOME", tempHome);
    resetMemoryProxyStateForTests();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetMemoryProxyStateForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("routes graphiti and cognee prefixes to local upstreams", () => {
    expect(resolveMemoryProxyTarget("/graphiti/search")).toEqual({
      service: "graphiti",
      targetBaseUrl: "http://127.0.0.1:8100",
      upstreamPath: "/search",
    });
    expect(resolveMemoryProxyTarget("/cognee/add")).toEqual({
      service: "cognee",
      targetBaseUrl: "http://127.0.0.1:8200",
      upstreamPath: "/add",
    });
    expect(resolveMemoryProxyTarget("/v1/chat/completions")).toBeNull();
  });

  it("derives trusted agent id from session key and ignores caller-supplied agent headers", () => {
    const req = {
      url: "/graphiti/search",
      headers: {
        host: "localhost",
        "x-openclaw-session-key": "agent:david:main",
        "x-openclaw-agent-id": "sentinel",
      },
    };
    expect(resolveTrustedMemoryAgentId({ req: req as never })).toBe("david");
  });

  it("falls back to openclaw model when no session key is present", () => {
    const req = { url: "/graphiti/search", headers: { host: "localhost" } };
    expect(
      resolveTrustedMemoryAgentId({
        req: req as never,
        body: { model: "openclaw/clara" },
      }),
    ).toBe("clara");
  });

  it("extracts cognee datasets from query or body", () => {
    expect(
      resolveMemoryDataset({
        service: "cognee",
        pathname: "/search",
        searchParams: new URLSearchParams("dataset=case-eea"),
      }),
    ).toBe("case-eea");
    expect(
      resolveMemoryDataset({
        service: "cognee",
        pathname: "/add",
        searchParams: new URLSearchParams(),
        body: { dataset: "platform-architecture" },
      }),
    ).toBe("platform-architecture");
  });

  it("classifies graphiti and cognee operations", () => {
    expect(classifyMemoryOperation({ service: "graphiti", pathname: "/episodes" })).toBe("write");
    expect(classifyMemoryOperation({ service: "graphiti", pathname: "/search" })).toBe("read");
    expect(classifyMemoryOperation({ service: "cognee", pathname: "/memify" })).toBe("memify");
    expect(classifyMemoryOperation({ service: "cognee", pathname: "/delete" })).toBe("delete");
    expect(classifyMemoryOperation({ service: "cognee", pathname: "/add" })).toBe("write");
  });

  it("enforces case read ACLs for case-eea and case-hrsp across configured agents", () => {
    // Rachel is intentionally absent from MEMORY_PROXY_CONFIGURED_AGENTS because she reaches
    // memory via MCP, not this gateway proxy. The gateway ACL still includes her as
    // defense-in-depth if that ever changes, so these proxy-path tests cover only agents that
    // can actually hit this handler.
    const allowedReaders = new Set(["sentinel", "bosshog", "bella"]);
    for (const dataset of ["case-eea", "case-hrsp"] as const) {
      for (const agentId of MEMORY_PROXY_CONFIGURED_AGENTS) {
        const acl = evaluateMemoryAcl({
          agentId,
          service: "cognee",
          operation: "read",
          dataset,
        });
        expect(acl.allowed).toBe(allowedReaders.has(agentId));
      }
    }
  });

  it("enforces dataset write ACLs for all configured agents", () => {
    // Rachel routes via MCP rather than the gateway proxy, so the proxy test matrix excludes her.
    // The ACL map still names Rachel explicitly as defense-in-depth for future routing changes.
    const cases = [
      ["case-eea", new Set(["sentinel"])],
      ["case-hrsp", new Set(["sentinel"])],
      ["podcast-research", new Set(["malcolm", "rook"])],
      ["platform-compliance", new Set(["sentinel", "clara"])],
      ["platform-architecture", new Set(["david", "clara"])],
    ] as const;

    for (const [dataset, allowed] of cases) {
      for (const agentId of MEMORY_PROXY_CONFIGURED_AGENTS) {
        const acl = evaluateMemoryAcl({
          agentId,
          service: "cognee",
          operation: "write",
          dataset,
        });
        expect(acl.allowed).toBe(allowed.has(agentId));
      }
    }
  });

  it("restricts delete/retract and disables memify on case datasets", () => {
    expect(
      evaluateMemoryAcl({
        agentId: "sentinel",
        service: "cognee",
        operation: "delete",
        dataset: "podcast-research",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateMemoryAcl({
        agentId: "david",
        service: "graphiti",
        operation: "retract",
        dataset: null,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateMemoryAcl({
        agentId: "clara",
        service: "cognee",
        operation: "memify",
        dataset: "case-hrsp",
      }).allowed,
    ).toBe(false);
    expect(
      evaluateMemoryAcl({
        agentId: "clara",
        service: "cognee",
        operation: "memify",
        dataset: "platform-compliance",
      }).allowed,
    ).toBe(true);
  });

  it("tracks the expected 13 configured agents for ACL verification", () => {
    expect(MEMORY_PROXY_CONFIGURED_AGENTS).toHaveLength(13);
    expect(new Set(MEMORY_PROXY_CONFIGURED_AGENTS).size).toBe(13);
    expect(listConfiguredMemoryAgents()).not.toContain("rachel");
  });

  it("restores the audit hash chain from the last persisted entry on restart", async () => {
    const auditDir = join(tempHome, ".openclaw", "audit");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "memory-access.jsonl"),
      `${JSON.stringify({ current_hash: "persisted-hash" })}\n`,
      "utf8",
    );

    await initializeMemoryProxyAuditState();

    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const listener = await startMemoryProxyServer();
    try {
      const response = await sendJsonRequest({
        baseUrl: listener.baseUrl,
        method: "POST",
        path: "/graphiti/search",
        headers: { "x-openclaw-session-key": "agent:david:main" },
        body: { query: "hello" },
      });
      expect(response.status).toBe(200);
    } finally {
      await listener.close();
    }

    const entries = await readAuditEntries(tempHome);
    expect(entries.at(-1)?.previous_hash).toBe("persisted-hash");
  });

  it("handles the full allow path auth to ACL to proxy to audit", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ results: [{ id: 1 }, { id: 2 }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-upstream": "ok" },
      }),
    );

    const listener = await startMemoryProxyServer();
    try {
      const response = await sendJsonRequest({
        baseUrl: listener.baseUrl,
        method: "POST",
        path: "/cognee/search?dataset=platform-compliance&agent_id=spoofed",
        headers: {
          "x-openclaw-session-key": "agent:clara:main",
          "x-openclaw-agent-id": "sentinel",
        },
        body: {
          dataset: "platform-compliance",
          query: "show me the architecture notes",
          agent_id: "spoofed",
        },
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"id":1');
      expect(response.headers["x-upstream"]).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [upstreamUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(upstreamUrl).toContain("http://127.0.0.1:8200/search?");
      expect(upstreamUrl).toContain("dataset=platform-compliance");
      expect(upstreamUrl).toContain("agent_id=clara");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("x-openclaw-agent-id")).toBe("clara");
      expect(typeof init.body).toBe("string");
      const forwarded = JSON.parse(init.body as string);
      expect(forwarded.agent_id).toBe("clara");

      const entries = await readAuditEntries(tempHome);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        record_type: "access",
        agent_id: "clara",
        dataset: "platform-compliance",
        status: "allow",
        result_count: 2,
      });
    } finally {
      await listener.close();
    }
  });

  it("denies unauthorized case access and emits an anomaly alert", async () => {
    const listener = await startMemoryProxyServer();
    try {
      const response = await sendJsonRequest({
        baseUrl: listener.baseUrl,
        method: "POST",
        path: "/cognee/search?dataset=case-hrsp",
        headers: { "x-openclaw-session-key": "agent:david:main" },
        body: { dataset: "case-hrsp", query: "classified" },
      });

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      const parsed = JSON.parse(response.body) as { error: { type: string } };
      expect(parsed.error.type).toBe("forbidden");

      const entries = await readAuditEntries(tempHome);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        record_type: "access",
        status: "deny",
        dataset: "case-hrsp",
        agent_id: "david",
      });
      expect(entries[1]).toMatchObject({
        record_type: "alert",
        category: "unauthorized_case_access",
        dataset: "case-hrsp",
        agent_id: "david",
      });
    } finally {
      await listener.close();
    }
  });

  it("records the correct chained audit hashes", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [{ id: 1 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const listener = await startMemoryProxyServer();
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await sendJsonRequest({
          baseUrl: listener.baseUrl,
          method: "POST",
          path: "/graphiti/search",
          headers: { "x-openclaw-session-key": "agent:david:main" },
          body: { query: `q-${i}` },
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await listener.close();
    }

    const entries = await readAuditEntries(tempHome);
    let previousHash = "GENESIS";
    for (const entry of entries) {
      expect(entry.previous_hash).toBe(previousHash);
      const { current_hash: _currentHash, ...entryWithoutCurrentHash } = entry;
      const payload = stableStringify({ ...entryWithoutCurrentHash, previous_hash: previousHash });
      const expectedHash = createHash("sha256")
        .update(`${previousHash}\n${payload}`, "utf8")
        .digest("hex");
      expect(entry.current_hash).toBe(expectedHash);
      previousHash = String(entry.current_hash);
    }
  });

  it("triggers a bulk export anomaly alert", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const listener = await startMemoryProxyServer();
    try {
      const response = await sendJsonRequest({
        baseUrl: listener.baseUrl,
        method: "GET",
        path: "/cognee/export?dataset=podcast-research&limit=101",
        headers: { "x-openclaw-session-key": "agent:malcolm:main" },
      });
      expect(response.status).toBe(200);
    } finally {
      await listener.close();
    }

    const entries = await readAuditEntries(tempHome);
    expect(entries[0]).toMatchObject({
      record_type: "alert",
      category: "bulk_export_attempt",
      dataset: "podcast-research",
      agent_id: "malcolm",
    });
    expect(entries[1]).toMatchObject({
      record_type: "access",
      status: "allow",
    });
  });

  it("triggers a query spike anomaly alert", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const listener = await startMemoryProxyServer();
    try {
      for (let i = 0; i < 21; i += 1) {
        const response = await sendJsonRequest({
          baseUrl: listener.baseUrl,
          method: "GET",
          path: "/graphiti/search",
          headers: { "x-openclaw-session-key": "agent:david:main" },
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await listener.close();
    }

    const entries = await readAuditEntries(tempHome);
    expect(
      entries.some((entry) => entry.record_type === "alert" && entry.category === "query_spike"),
    ).toBe(true);
  });
});
