import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const GITHUB_RELEASE_JSON_MAX_BYTES = 1024 * 1024;

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

let originalAgentDir: string | undefined;
let tempAgentDir: string | undefined;

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

beforeEach(() => {
  originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  tempAgentDir = mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);
  fetchWithSsrFGuardMock.mockReset();
  spawnSyncMock.mockReturnValue({
    error: new Error("ENOENT"),
    status: null,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  if (originalAgentDir === undefined) {
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
  } else {
    setTestEnvValue("OPENCLAW_AGENT_DIR", originalAgentDir);
  }
  if (tempAgentDir) {
    rmSync(tempAgentDir, { recursive: true, force: true });
  }
  tempAgentDir = undefined;
});

describe("ensureTool", () => {
  it("cancels release-check error bodies before releasing guarded fetches", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const release = vi.fn(async () => {});
    const response = new Response("server error", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).rejects.toThrow("GitHub API error: 503");

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels download error bodies before releasing guarded fetches", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    const downloadResponse = new Response("missing asset", { status: 404 });
    const cancel = vi.spyOn(downloadResponse.body!, "cancel").mockResolvedValue(undefined);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }),
        release: releaseCheckRelease,
        finalUrl: "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      })
      .mockResolvedValueOnce({
        response: downloadResponse,
        release: downloadRelease,
        finalUrl: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/archive",
      });

    await expect(ensureTool("rg", true)).rejects.toThrow("Failed to download: 404");

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseCheckRelease).toHaveBeenCalledOnce();
    expect(downloadRelease).toHaveBeenCalledOnce();
  });

  it("extracts Windows zip downloads with trusted System32 tools", async () => {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      arch: () => "x64",
      platform: () => "win32",
    }));

    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }),
        release: releaseCheckRelease,
        finalUrl: "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      })
      .mockResolvedValueOnce({
        response: new Response("zip-bytes", { status: 200 }),
        release: downloadRelease,
        finalUrl: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/archive.zip",
      });
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "C:\\Windows\\System32\\tar.exe") {
        return {
          error: undefined,
          status: 1,
          stderr: Buffer.from("tar failed"),
          stdout: Buffer.alloc(0),
        };
      }
      if (command === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
        const extractDir = args.at(-1);
        if (!extractDir) {
          throw new Error("expected extraction destination");
        }
        writeFileSync(join(extractDir, "rg.exe"), "binary");
        return {
          error: undefined,
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
        };
      }
      return {
        error: new Error(`unexpected command: ${command}`),
        status: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      };
    });

    await expect(ensureTool("rg", true)).resolves.toBe(join(tempAgentDir!, "bin", "rg.exe"));

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "C:\\Windows\\System32\\tar.exe",
      expect.any(Array),
      { stdio: "pipe" },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.any(Array),
      { stdio: "pipe" },
    );
  });

  it.each([
    { body: "{not json", error: "GitHub release response is malformed JSON" },
    {
      body: JSON.stringify({ tag_name: 42 }),
      error: "GitHub release response has no valid tag_name",
    },
  ])("rejects corrupt release metadata: $error", async ({ body, error }) => {
    const { ensureTool } = await import("./tools-manager.js");
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, { status: 200 }),
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).rejects.toThrow(error);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the guarded response when the release stream aborts", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const release = vi.fn(async () => {});
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const error = new Error("release lookup aborted");
        error.name = "AbortError";
        controller.error(error);
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, { status: 200 }),
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).rejects.toThrow("release lookup aborted");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("surfaces download failures through non-silent logging", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const release = vi.fn(async () => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("server error", { status: 503 }),
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    try {
      await expect(ensureTool("fd")).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("GitHub API error: 503"));
      expect(release).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("uses the fdfind system fallback without starting a download", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    spawnSyncMock
      .mockReturnValueOnce({
        error: new Error("ENOENT"),
        status: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("fd 10.4.2"),
      });

    await expect(ensureTool("fd", true)).resolves.toBe("fdfind");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("bounds the real tool-resolution path against streamed HTTP release metadata", async () => {
    const totalBytes = 16 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let streamedBytes = 0;
    let requestUrl: string | undefined;
    const server = createServer((req, res) => {
      requestUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"tag_name":"v');

      const writeMore = () => {
        while (streamedBytes < totalBytes && !res.destroyed) {
          streamedBytes += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        if (!res.destroyed) {
          res.end('"}');
        }
      };
      writeMore();
    });
    const port = await listenLoopbackServer(server);
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementationOnce(async () => ({
      response: await fetch(`http://127.0.0.1:${port}/release/latest`),
      release,
      finalUrl: `http://127.0.0.1:${port}/release/latest`,
    }));

    try {
      const { ensureTool } = await import("./tools-manager.js");
      await expect(ensureTool("fd", true)).rejects.toThrow(
        `GitHub release response exceeds ${GITHUB_RELEASE_JSON_MAX_BYTES} bytes`,
      );

      expect(requestUrl).toBe("/release/latest");
      expect(streamedBytes).toBeLessThan(totalBytes);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });
});

describe("getToolPath exit-status handling", () => {
  it("treats a binary that spawns but exits non-zero as missing", async () => {
    const { getToolPath } = await import("./tools-manager.js");
    // execve succeeded (no result.error) but the child exited non-zero — the
    // signature of an installed-but-broken binary (GLIBC / shared-lib mismatch).
    // Must not be reported as available, or ensureTool skips its download path.
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    expect(getToolPath("fd")).toBeNull();
  });

  it("reports a binary present when it spawns and exits 0", async () => {
    const { getToolPath } = await import("./tools-manager.js");
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    expect(getToolPath("fd")).toBe("fd");
  });
});
