import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

let originalAgentDir: string | undefined;
let tempAgentDir: string | undefined;

beforeEach(() => {
  originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  tempAgentDir = mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
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
    delete process.env.OPENCLAW_AGENT_DIR;
  } else {
    process.env.OPENCLAW_AGENT_DIR = originalAgentDir;
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

    await expect(ensureTool("fd", true)).resolves.toBeUndefined();

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

    await expect(ensureTool("rg", true)).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseCheckRelease).toHaveBeenCalledOnce();
    expect(downloadRelease).toHaveBeenCalledOnce();
  });
});
