import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../../process/exec.js";
import { createSandboxedReadTool } from "../agent-tools.read.js";
import type { SandboxBackendCommandParams } from "../sandbox/backend-handle.types.js";
import { createSandboxFsBridge } from "../sandbox/fs-bridge.js";
import { bindSandboxInputStager, createSandboxInputStager } from "../sandbox/input-staging.js";
import { createRemoteShellSandboxFsBridge } from "../sandbox/remote-fs-bridge.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createWebFetchTool } from "./web-fetch.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("./web-guarded-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./web-guarded-fetch.js")>()),
  fetchWithWebToolsNetworkGuard: fetchMock,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const marker = "OMITTED_RESPONSE_MARKER";
const fullText = `${"line of fetched content\n".repeat(1_000)}${marker}\n`;

function context(root: string, session: string, assertInvocationCurrent?: () => void) {
  const bridge = createHostSandboxFsBridge(root);
  bindSandboxInputStager(
    bridge,
    createSandboxInputStager({ root, bridge, assertCurrent: () => {} }),
  );
  const options = {
    sandboxed: true,
    sandboxRoot: root,
    sandboxFsBridge: bridge,
    agentSessionKey: session,
    assertInvocationCurrent,
    config: { tools: { web: { fetch: { maxChars: 1_000, cacheTtlMinutes: 1 } } } },
  };
  return {
    bridge,
    options,
    fetch: createWebFetchTool(options)!,
    read: createSandboxedReadTool({ root, bridge }),
  };
}

function details(result: { details?: unknown }) {
  return result.details as { text: string; cached?: boolean; spill?: { path: string } };
}

function mockResponse() {
  return {
    response: new Response(fullText, { headers: { "content-type": "text/plain" } }),
    finalUrl: "https://example.com/sandbox-output",
    release: async () => {},
  };
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("web_fetch sandbox output recovery", () => {
  it("recovers omitted content through bounded read and keeps cached files with their requester", async () => {
    fetchMock.mockImplementation(async () => mockResponse());
    const root = tempDirs.make("web-fetch-sandbox-");
    const first = context(root, "first");
    const args = { url: "https://example.com/sandbox-output" };
    const original = details(await first.fetch.execute("fetch", args));
    assert(original.spill);
    expect(original.text).not.toContain(marker);
    expect(original.text.length).toBeLessThanOrEqual(1_000);
    expect(original.text).toContain(`Full output: ${original.spill.path}`);
    const recovered = await first.read.execute("read", {
      path: original.spill.path,
      offset: 1_000,
      limit: 30,
    });
    expect(JSON.stringify(recovered)).toContain(marker);
    expect(JSON.stringify(recovered).length).toBeLessThan(4_000);
    const saved = first.bridge.resolvePath({ filePath: original.spill.path });
    assert(saved.hostPath);
    expect(
      await fs.readFile(path.join(path.dirname(saved.hostPath), ".gitignore"), "utf8"),
    ).toContain("*\n");

    // Rebuilding tools for the same session must preserve usable cached output.
    const cached = details(await context(root, "first").fetch.execute("cached", args));
    expect(cached.cached).toBe(true);
    expect(cached.spill).toEqual(original.spill);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = context(tempDirs.make("web-fetch-other-"), "second");
    const other = details(await second.fetch.execute("other", args));
    assert(other.spill);
    expect(other.cached).toBeUndefined();
    expect(other.spill.path).not.toBe(original.spill.path);
    expect(
      JSON.stringify(
        await second.read.execute("read", { path: other.spill.path, offset: 1_000, limit: 30 }),
      ),
    ).toContain(marker);
    await expect(second.read.execute("foreign", { path: original.spill.path })).rejects.toThrow();

    const sameRoot = details(
      await context(root, "another-session").fetch.execute("same-root", args),
    );
    expect(sameRoot.cached).toBeUndefined();
    expect(sameRoot.spill?.path).not.toBe(original.spill.path);

    await fs.rm(saved.hostPath);
    const renewed = details(await first.fetch.execute("renew", args));
    expect(renewed.cached).toBeUndefined();
    expect(renewed.spill?.path).not.toBe(original.spill.path);
    const outside = path.join(tempDirs.make("web-fetch-host-only-"), "private.txt");
    await fs.writeFile(outside, "UNRELATED_HOST_FILE");
    await expect(first.read.execute("host", { path: outside })).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "stages readable output without granting guest writes in a read-only workspace",
    async () => {
      fetchMock.mockImplementation(async () => mockResponse());
      const root = tempDirs.make("web-fetch-native-read-only-");
      const sandbox = createSandboxTestContext({
        overrides: {
          workspaceDir: root,
          agentWorkspaceDir: root,
          containerWorkdir: root,
          workspaceAccess: "ro",
        },
      });
      const backend = {
        runShellCommand: async (params: SandboxBackendCommandParams) => {
          const result = await runCommandBuffered(
            ["sh", "-c", params.script, "web-fetch-sandbox-test", ...(params.args ?? [])],
            { input: params.stdin, signal: params.signal, timeoutMs: 10_000 },
          );
          if (result.code !== 0 && !params.allowFailure) {
            throw new Error(result.stderr.toString());
          }
          return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
      };
      const bridge = createSandboxFsBridge({ sandbox: { ...sandbox, backend } });
      bindSandboxInputStager(
        bridge,
        createSandboxInputStager({ root, bridge, assertCurrent: () => {} }),
      );
      await expect(
        bridge.createFileExclusive!({ filePath: "guest-write.txt", data: "denied" }),
      ).rejects.toThrow("read-only");
      const tool = createWebFetchTool({
        ...context(root, "native-read-only").options,
        sandboxFsBridge: bridge,
      })!;
      const result = details(
        await tool.execute("fetch", { url: "https://example.com/native-read-only" }),
      );
      assert(result.spill);
      const read = createSandboxedReadTool({ root, bridge });
      expect(
        JSON.stringify(
          await read.execute("read", { path: result.spill.path, offset: 1_000, limit: 30 }),
        ),
      ).toContain(marker);
      expect((await fs.stat(result.spill.path)).mode & 0o077).toBe(0);
      await expect(fs.stat(path.join(root, "guest-write.txt"))).rejects.toThrow();
      await fs.rm(path.dirname(result.spill.path), { recursive: true });
      const renewed = details(
        await tool.execute("renew", { url: "https://example.com/native-read-only" }),
      );
      expect(renewed.cached).toBeUndefined();
      assert(renewed.spill);
      expect(renewed.spill.path).not.toBe(result.spill.path);
      expect(
        JSON.stringify(
          await read.execute("renewed-read", {
            path: renewed.spill.path,
            offset: 1_000,
            limit: 30,
          }),
        ),
      ).toContain(marker);
    },
  );

  it("returns bounded content without a false host-file promise when a backend cannot stage output", async () => {
    fetchMock.mockImplementation(async () => mockResponse());
    const sandbox = context(tempDirs.make("web-fetch-unavailable-"), "unavailable");
    const runRemoteShellScript = vi.fn(async () => {
      throw new Error("Unsupported staging must not run a remote command");
    });
    const unsupported = createWebFetchTool({
      ...sandbox.options,
      sandboxFsBridge: createRemoteShellSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: {
            workspaceDir: sandbox.options.sandboxRoot,
            agentWorkspaceDir: sandbox.options.sandboxRoot,
          },
        }),
        runtime: {
          remoteWorkspaceDir: "/workspace",
          remoteAgentWorkspaceDir: "/workspace",
          runRemoteShellScript,
        },
      }),
    })!;
    const args = { url: "https://example.com/sandbox-unavailable" };
    const failed = details(await unsupported.execute("unavailable", args));
    expect(failed.spill).toBeUndefined();
    expect(failed.text).toContain("line of fetched content");
    expect(failed.text).toContain("Full output unavailable in sandbox");
    expect(failed.text.length).toBeLessThanOrEqual(1_000);
    expect(runRemoteShellScript).not.toHaveBeenCalled();
    expect(await fs.readdir(sandbox.options.sandboxRoot)).toEqual([]);
    const retry = details(
      await context(sandbox.options.sandboxRoot, "unavailable").fetch.execute("retry", args),
    );
    expect(retry.cached).toBeUndefined();
    expect(retry.spill).toBeDefined();
  });

  it("does not stage a response or reuse a cache after requester authority ends", async () => {
    const response = createDeferred<ReturnType<typeof mockResponse>>();
    fetchMock.mockReturnValueOnce(response.promise).mockImplementation(async () => mockResponse());
    const root = tempDirs.make("web-fetch-authority-");
    let current = true;
    const sandbox = context(root, "authority", () => {
      if (!current) {
        throw new Error("requester ended");
      }
    });
    const args = { url: "https://example.com/sandbox-authority" };
    const pending = sandbox.fetch.execute("revoked", args);
    const rejection = expect(pending).rejects.toThrow("requester ended");
    current = false;
    response.resolve(mockResponse());
    await rejection;
    expect(await fs.readdir(root)).toEqual([]);
    current = true;
    expect(details(await sandbox.fetch.execute("fresh", args)).cached).toBeUndefined();
    current = false;
    await expect(sandbox.fetch.execute("cached-revoked", args)).rejects.toThrow("requester ended");
  });
});
