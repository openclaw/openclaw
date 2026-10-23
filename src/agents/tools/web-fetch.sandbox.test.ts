import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

function context(
  root: string,
  session: string,
  assertInvocationCurrent?: () => void,
  bridge = createHostSandboxFsBridge(root),
) {
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

function sandboxContext(root: string, workspaceAccess: "ro" | "rw" = "rw") {
  return createSandboxTestContext({
    overrides: {
      workspaceDir: root,
      agentWorkspaceDir: root,
      containerWorkdir: workspaceAccess === "ro" ? root : "/workspace",
      workspaceAccess,
    },
  });
}

function details(result: { details?: unknown }) {
  return result.details as { text: string; cached?: boolean; spill?: { path: string } };
}

async function fetch(tool: NonNullable<ReturnType<typeof createWebFetchTool>>, suffix = "output") {
  return details(await tool.execute("fetch", { url: `https://example.com/sandbox-${suffix}` }));
}

function expectFresh(result: ReturnType<typeof details>, previousPath: string) {
  expect(result.cached).toBeUndefined();
  expect(result.spill?.path).not.toBe(previousPath);
}

function mockResponse() {
  return {
    response: new Response(fullText, { headers: { "content-type": "text/plain" } }),
    finalUrl: "https://example.com/sandbox-output",
    release: async () => {},
  };
}

async function readSpill(read: ReturnType<typeof createSandboxedReadTool>, filePath: string) {
  return JSON.stringify(await read.execute("read", { path: filePath, offset: 1_000, limit: 30 }));
}

beforeEach(() => fetchMock.mockImplementation(async () => mockResponse()));
afterEach(() => fetchMock.mockReset());

it("recovers omitted content through bounded read and keeps cached files with their requester", async () => {
  const root = tempDirs.make("web-fetch-sandbox-");
  const first = context(root, "first");
  const original = await fetch(first.fetch);
  assert(original.spill);
  expect(original.text).not.toContain(marker);
  expect(original.text.length).toBeLessThanOrEqual(1_000);
  expect(original.text).toContain(`Full output: ${original.spill.path}`);
  const recovered = await readSpill(first.read, original.spill.path);
  expect(recovered).toContain(marker);
  expect(recovered.length).toBeLessThan(4_000);
  const saved = first.bridge.resolvePath({ filePath: original.spill.path });
  assert(saved.hostPath);
  expect(
    await fs.readFile(path.join(path.dirname(saved.hostPath), ".gitignore"), "utf8"),
  ).toContain("*\n");

  const cached = await fetch(context(root, "first").fetch);
  expect([cached.cached, cached.spill]).toEqual([true, original.spill]);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const second = context(tempDirs.make("web-fetch-other-"), "second");
  const other = await fetch(second.fetch);
  assert(other.spill);
  expectFresh(other, original.spill.path);
  expect(await readSpill(second.read, other.spill.path)).toContain(marker);
  await expect(second.read.execute("foreign", { path: original.spill.path })).rejects.toThrow();

  expectFresh(await fetch(context(root, "another-session").fetch), original.spill.path);

  await fs.rm(saved.hostPath);
  expectFresh(await fetch(first.fetch), original.spill.path);
  const outside = path.join(tempDirs.make("web-fetch-host-only-"), "private.txt");
  await fs.writeFile(outside, "UNRELATED_HOST_FILE");
  await expect(first.read.execute("host", { path: outside })).rejects.toThrow();
});

it.runIf(process.platform !== "win32")("stages read-only output", async () => {
  const root = tempDirs.make("web-fetch-native-read-only-");
  const sandbox = sandboxContext(root, "ro");
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
  const native = context(root, "native-read-only", undefined, bridge);
  await expect(
    bridge.createFileExclusive!({ filePath: "guest-write.txt", data: "denied" }),
  ).rejects.toThrow("read-only");
  const result = await fetch(native.fetch, "native-read-only");
  assert(result.spill);
  expect(await readSpill(native.read, result.spill.path)).toContain(marker);
  expect((await fs.stat(result.spill.path)).mode & 0o077).toBe(0);
  await expect(fs.stat(path.join(root, "guest-write.txt"))).rejects.toThrow();
  await fs.rm(path.dirname(result.spill.path), { recursive: true });
  const renewed = await fetch(native.fetch, "native-read-only");
  assert(renewed.spill);
  expectFresh(renewed, result.spill.path);
  expect(await readSpill(native.read, renewed.spill.path)).toContain(marker);
});

it("returns bounded content without a false host-file promise when a backend cannot stage output", async () => {
  const root = tempDirs.make("web-fetch-unavailable-");
  const sandbox = context(root, "unavailable");
  const runRemoteShellScript = vi.fn(async () => {
    throw new Error("Unsupported staging must not run a remote command");
  });
  const unsupported = createWebFetchTool({
    ...sandbox.options,
    sandboxFsBridge: createRemoteShellSandboxFsBridge({
      sandbox: sandboxContext(root),
      runtime: {
        remoteWorkspaceDir: "/workspace",
        remoteAgentWorkspaceDir: "/workspace",
        runRemoteShellScript,
      },
    }),
  })!;
  const failed = await fetch(unsupported, "unavailable");
  expect(failed.spill).toBeUndefined();
  expect(failed.text).toContain("line of fetched content");
  expect(failed.text).toContain("Full output unavailable in sandbox");
  expect(failed.text.length).toBeLessThanOrEqual(1_000);
  expect(runRemoteShellScript).not.toHaveBeenCalled();
  expect(await fs.readdir(root)).toEqual([]);
  const retry = await fetch(context(root, "unavailable").fetch, "unavailable");
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
  const pending = fetch(sandbox.fetch, "authority");
  const rejection = expect(pending).rejects.toThrow("requester ended");
  current = false;
  response.resolve(mockResponse());
  await rejection;
  expect(await fs.readdir(root)).toEqual([]);
  current = true;
  expect((await fetch(sandbox.fetch, "authority")).cached).toBeUndefined();
  current = false;
  await expect(fetch(sandbox.fetch, "authority")).rejects.toThrow("requester ended");
});
