import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

type RuntimeMock = {
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
};

function createRuntime(): RuntimeMock & { writeJson: ReturnType<typeof vi.fn> } {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    writeJson: vi.fn(),
  };
}

function createJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } satisfies Partial<Response>;
}

describe("runQdrantWorkspaceReconcileCommand", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;
  let workspaceDir = "";

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qdrant-reconcile-"));
    await fs.mkdir(path.join(workspaceDir, "projects"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "projects", "demo.md"),
      "# Demo\n\nAlpha section.\n\n## Details\n\nBeta section.\n\n## Extra\n\nGamma section.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("dry-run prints counts and never upserts or deletes", async () => {
    const { buildWorkspaceReconcilePlan } =
      await import("../memory-host-sdk/host/workspace-reconcile.js");
    const plan = await buildWorkspaceReconcilePlan(workspaceDir, "2026-05-17T00:00:00.000Z");
    const unchanged = plan.points[0];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/collections/agent-memory")) {
        expect(init?.method ?? "GET").toBe("GET");
        return createJsonResponse({ result: { status: "green", points_count: 7 } });
      }
      if (url.endsWith("/collections/agent-memory/points/scroll")) {
        return createJsonResponse({
          result: {
            points: [
              {
                id: unchanged?.id,
                payload: unchanged?.payload,
              },
              {
                id: "workspace:projects/stale.md#0",
                payload: {
                  managed_by: "workspace-reconciler",
                  content_hash: "stale-hash",
                },
              },
            ],
            next_page_offset: null,
          },
        });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const runtime = createRuntime();

    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    await runQdrantWorkspaceReconcileCommand(
      { dryRun: true, workspaceDir },
      runtime as unknown as RuntimeEnv,
    );

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/points?wait=true")),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/points/delete?wait=true")),
    ).toBe(false);
    const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Files scanned: 1");
    expect(output).toContain(`Chunks built: ${plan.points.length}`);
    expect(output).toContain("Unchanged points: 1");
    expect(output).toContain(`New points: ${plan.points.length - 1}`);
    expect(output).toContain("Deleted points: 1");
  });

  it("defaults to dry-run when no mode flag is set", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/collections/agent-memory")) {
        return createJsonResponse({ result: { status: "green", points_count: 7 } });
      }
      if (url.endsWith("/collections/agent-memory/points/scroll")) {
        return createJsonResponse({
          result: {
            points: [],
            next_page_offset: null,
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const runtime = createRuntime();

    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    const result = await runQdrantWorkspaceReconcileCommand(
      { workspaceDir },
      runtime as unknown as RuntimeEnv,
    );

    expect(result.mode).toBe("dry-run");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting apply and dry-run flags", async () => {
    const runtime = createRuntime();
    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    await expect(
      runQdrantWorkspaceReconcileCommand(
        { apply: true, dryRun: true, workspaceDir },
        runtime as unknown as RuntimeEnv,
      ),
    ).rejects.toThrow("Choose either --dry-run or --apply");
  });

  it("resolves host-friendly defaults when container paths are absent", async () => {
    const { resolveQdrantWorkspaceReconcileOptions } =
      await import("./qdrant-workspace-reconcile.js");

    const resolved = resolveQdrantWorkspaceReconcileOptions({
      env: {},
      pathExists: () => false,
      homeDir: "/home/tester",
    });

    expect(resolved.mode).toBe("dry-run");
    expect(resolved.collection).toBe("agent-memory");
    expect(resolved.qdrantUrl).toBe("http://127.0.0.1:6333");
    expect(resolved.workspaceDir).toBe("/home/tester/.openclaw/workspace");
    expect(resolved.pythonPath).toBe(
      "/home/tester/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python",
    );
  });

  it("prefers container defaults when container paths exist", async () => {
    const { resolveQdrantWorkspaceReconcileOptions } =
      await import("./qdrant-workspace-reconcile.js");

    const resolved = resolveQdrantWorkspaceReconcileOptions({
      env: {},
      pathExists: (candidate) =>
        candidate === "/home/node/.openclaw/workspace" ||
        candidate ===
          "/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python",
      homeDir: "/home/tester",
    });

    expect(resolved.qdrantUrl).toBe("http://qdrant:6333");
    expect(resolved.workspaceDir).toBe("/home/node/.openclaw/workspace");
    expect(resolved.pythonPath).toBe(
      "/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python",
    );
  });

  it("apply upserts only new or changed points, defaults collection, and honors python env override", async () => {
    process.env.OPENCLAW_QDRANT_FASTEMBED_PYTHON = "/tmp/custom-fastembed-python";
    const { buildWorkspaceReconcilePlan } =
      await import("../memory-host-sdk/host/workspace-reconcile.js");
    const plan = await buildWorkspaceReconcilePlan(workspaceDir, "2026-05-17T00:00:00.000Z");
    const unchanged = plan.points[0];
    const updated = plan.points[1];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/collections/agent-memory")) {
        return createJsonResponse({ result: { status: "green", points_count: 7 } });
      }
      if (url.endsWith("/collections/agent-memory/points/scroll")) {
        return createJsonResponse({
          result: {
            points: [
              {
                id: unchanged?.id,
                payload: unchanged?.payload,
              },
              {
                id: updated?.id,
                payload: {
                  ...updated?.payload,
                  content_hash: "outdated-hash",
                },
              },
              {
                id: "workspace:projects/stale.md#0",
                payload: {
                  managed_by: "workspace-reconciler",
                  content_hash: "stale-hash",
                },
              },
            ],
            next_page_offset: null,
          },
        });
      }
      if (url.endsWith("/collections/agent-memory/points?wait=true")) {
        return createJsonResponse({ status: "ok" });
      }
      if (url.endsWith("/collections/agent-memory/points/delete?wait=true")) {
        return createJsonResponse({ status: "ok" });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        vectors: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }),
      stderr: "",
    });
    const runtime = createRuntime();

    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    const result = await runQdrantWorkspaceReconcileCommand(
      { apply: true, workspaceDir },
      runtime as unknown as RuntimeEnv,
    );

    expect(result.collection).toBe("agent-memory");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/tmp/custom-fastembed-python",
      expect.any(Array),
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
    const upsertCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/collections/agent-memory/points?wait=true"),
    );
    expect(upsertCall).toBeTruthy();
    const upsertBodyRaw = upsertCall?.[1]?.body;
    if (typeof upsertBodyRaw !== "string") {
      throw new TypeError("expected upsert body to be a string");
    }
    const upsertBody = JSON.parse(upsertBodyRaw) as {
      points: Array<{ id: string; vector: number[] }>;
    };
    const { workspaceIdToUuid } = await import("./qdrant-workspace-reconcile.js");
    expect(upsertBody.points.map((point) => point.id)).toEqual(
      expect.arrayContaining([
        workspaceIdToUuid(updated?.id ?? ""),
        workspaceIdToUuid(plan.points.at(-1)?.id ?? ""),
      ]),
    );
    expect(upsertBody.points).toHaveLength(2);

    const deleteCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/collections/agent-memory/points/delete?wait=true"),
    );
    expect(deleteCall).toBeTruthy();
    const deleteBodyRaw = deleteCall?.[1]?.body;
    if (typeof deleteBodyRaw !== "string") {
      throw new TypeError("expected delete body to be a string");
    }
    expect(JSON.parse(deleteBodyRaw)).toEqual({
      points: ["workspace:projects/stale.md#0"],
    });
  });

  it("skips delete when embedding fails after inventory build", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/collections/agent-memory")) {
        return createJsonResponse({ result: { status: "green", points_count: 7 } });
      }
      if (url.endsWith("/collections/agent-memory/points/scroll")) {
        return createJsonResponse({
          result: {
            points: [
              {
                id: "workspace:projects/stale.md#0",
                payload: {
                  managed_by: "workspace-reconciler",
                  content_hash: "stale-hash",
                },
              },
            ],
            next_page_offset: null,
          },
        });
      }
      if (url.endsWith("/collections/agent-memory/points/delete?wait=true")) {
        return createJsonResponse({ status: "ok" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "embed failed",
    });
    const runtime = createRuntime();

    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    await expect(
      runQdrantWorkspaceReconcileCommand(
        { apply: true, workspaceDir },
        runtime as unknown as RuntimeEnv,
      ),
    ).rejects.toThrow("embed failed");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/collections/agent-memory/points/delete?wait=true"),
      ),
    ).toBe(false);
  });

  it("preserves stale points owned by other writers during apply", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/collections/agent-memory")) {
        return createJsonResponse({ result: { status: "green", points_count: 7 } });
      }
      if (url.endsWith("/collections/agent-memory/points/scroll")) {
        return createJsonResponse({
          result: {
            points: [
              {
                id: "workspace:projects/stale.md#0",
                payload: {
                  managed_by: "workspace-reconciler",
                  content_hash: "stale-hash",
                  payload_schema_version: 2,
                },
              },
              {
                id: "external-memory",
                payload: {
                  managed_by: "mcp-store",
                  content_hash: "external-hash",
                },
              },
            ],
            next_page_offset: null,
          },
        });
      }
      if (url.endsWith("/collections/agent-memory/points?wait=true")) {
        return createJsonResponse({ status: "ok" });
      }
      if (url.endsWith("/collections/agent-memory/points/delete?wait=true")) {
        return createJsonResponse({ status: "ok" });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    spawnSyncMock.mockImplementation((_pythonPath, _args, options) => {
      const input = options?.input;
      if (typeof input !== "string") {
        throw new TypeError("expected embedding bridge input to be a string");
      }
      const parsed = JSON.parse(input) as { texts: string[] };
      return {
        status: 0,
        stdout: JSON.stringify({
          vectors: parsed.texts.map(() => [0.1, 0.2]),
        }),
        stderr: "",
      };
    });
    const runtime = createRuntime();

    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    await runQdrantWorkspaceReconcileCommand(
      { apply: true, workspaceDir },
      runtime as unknown as RuntimeEnv,
    );

    const deleteCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/collections/agent-memory/points/delete?wait=true"),
    );
    expect(deleteCall).toBeTruthy();
    const deleteBodyRaw = deleteCall?.[1]?.body;
    if (typeof deleteBodyRaw !== "string") {
      throw new TypeError("expected delete body to be a string");
    }
    expect(JSON.parse(deleteBodyRaw)).toEqual({
      points: ["workspace:projects/stale.md#0"],
    });
  });

  it("retries upsert once when the first PUT fails with EPIPE on a stale keep-alive socket", async () => {
    let upsertAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/collections/agent-memory")) {
        return createJsonResponse({ result: { status: "green", points_count: 0 } });
      }
      if (url.endsWith("/collections/agent-memory/points/scroll")) {
        return createJsonResponse({ result: { points: [], next_page_offset: null } });
      }
      if (url.endsWith("/collections/agent-memory/points?wait=true")) {
        upsertAttempts += 1;
        if (upsertAttempts === 1) {
          const err = new TypeError("fetch failed") as Error & { cause?: unknown };
          err.cause = Object.assign(new Error("write EPIPE"), {
            code: "EPIPE",
            syscall: "write",
          });
          throw err;
        }
        return createJsonResponse({ status: "ok" });
      }
      if (url.endsWith("/collections/agent-memory/points/delete?wait=true")) {
        return createJsonResponse({ status: "ok" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        vectors: [
          [0.1, 0.2],
          [0.3, 0.4],
          [0.5, 0.6],
        ],
      }),
      stderr: "",
    });
    const runtime = createRuntime();

    const { runQdrantWorkspaceReconcileCommand } = await import("./qdrant-workspace-reconcile.js");

    const result = await runQdrantWorkspaceReconcileCommand(
      { apply: true, workspaceDir },
      runtime as unknown as RuntimeEnv,
    );

    expect(result.ok).toBe(true);
    expect(upsertAttempts).toBe(2);
  });
});

describe("embedWorkspaceTexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns the embedder once even when more than 50 texts are embedded", async () => {
    spawnSyncMock.mockImplementation((pythonPath, args, options) => {
      expect(pythonPath).toBe("/tmp/python");
      expect(args).toEqual(["-c", expect.any(String)]);
      const input = options?.input;
      if (typeof input !== "string") {
        throw new TypeError("expected embedding bridge input to be a string");
      }
      const parsed = JSON.parse(input) as { texts: string[] };
      return {
        status: 0,
        stdout: JSON.stringify({
          vectors: parsed.texts.map((_, index) => [index, index + 0.5]),
        }),
        stderr: "",
      };
    });

    const { embedWorkspaceTexts } = await import("./qdrant-workspace-reconcile.js");

    const vectors = embedWorkspaceTexts(
      Array.from({ length: 51 }, (_, index) => `chunk ${index}`),
      "/tmp/python",
    );

    expect(vectors).toHaveLength(51);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("classifyWorkspacePoints", () => {
  it("re-upserts points when the payload schema version is older even if the content hash matches", async () => {
    const { classifyWorkspacePoints } = await import("./qdrant-workspace-reconcile.js");
    const { buildWorkspaceReconcilePlan } =
      await import("../memory-host-sdk/host/workspace-reconcile.js");

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qdrant-classify-"));
    try {
      await fs.mkdir(path.join(workspaceDir, "projects"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "projects", "demo.md"),
        "# Demo\n\nAlpha section.\n",
        "utf8",
      );
      const plan = await buildWorkspaceReconcilePlan(workspaceDir, "2026-05-17T00:00:00.000Z");
      const point = plan.points[0];
      if (!point) {
        throw new Error("expected workspace reconcile point");
      }

      const result = classifyWorkspacePoints(
        [point],
        [
          {
            id: point.id,
            qdrantId: point.id,
            payload: {
              ...point.payload,
              payload_schema_version: 1,
            },
          },
        ],
      );

      expect(result.unchanged).toEqual([]);
      expect(result.toUpsert).toEqual([point]);
      expect(result.toDelete).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
