import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  fetchMcpAppView,
  getMcpAppViewLease,
  releaseMcpAppView,
} from "../../agents/mcp-ui-resource.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { captureSessionDiffBaseline } from "../../sessions/session-diff.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createMcpAppWorkspaceUploadProvider } from "../mcp-app-form-resources.js";
import { prepareMcpAppHostFile, readMcpAppHostFile } from "../mcp-app-host-files.js";
import { runtime as createMcpRuntime } from "./mcp-app.test-support.js";
import * as openPath from "./open-path.js";
import { loadSessionDiff } from "./sessions-diff.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createSessionFilesClient,
  createSessionFileDownloadClient,
} from "./sessions-files.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import * as workspaceFs from "./workspace-fs.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const key = "agent:main:dashboard:incognito-files";
const sid = "private-files";
const target = { sessionKey: key, agentId: "main" };
let storePath: string;
let env: NodeJS.ProcessEnv;
let workspace: string;
let cfg: OpenClawConfig;
let entry: SessionEntry;
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const files = createSessionFilesClient(invoke, () => ({ sessionKey: key, context }));
const context = {
  getRuntimeConfig: () => cfg,
  logGateway: createSubsystemLogger("gateway/test/incognito-files"),
};

async function withoutHostSql(run: () => Promise<void>) {
  const sql = observeHostDataSql();
  await run().finally(sql.restore);
  expect(sql.queries).toEqual([]);
}

function setConfig(value: OpenClawConfig) {
  setRuntimeConfigSnapshot((cfg = value));
}

beforeAll(async () => {
  workspace = dirs.make("incognito-workspace-files-");
  env = { OPENCLAW_STATE_DIR: dirs.make("incognito-files-actor-") };
  setConfig({ agents: { entries: { main: { workspace } } }, mcp: { apps: { enabled: true } } });
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  execFileSync("git", ["init", "-q", "-b", "main", workspace]);
  await writeFile(path.join(workspace, "example.txt"), "before session\n");
  const baseline = await captureSessionDiffBaseline({ cwd: workspace, sessionId: sid });
  assert(baseline);
  entry = {
    sessionId: sid,
    updatedAt: Date.now(),
    incognito: true,
    spawnedCwd: workspace,
    sessionDiffBaseline: baseline,
  };
  await replaceSessionEntry({ sessionKey: key, storePath }, entry);
  await appendTranscriptMessage(
    { sessionKey: key, sessionId: sid, storePath },
    {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "write-file", name: "write", arguments: { path: "example.txt" } },
        ],
      },
    },
  );
});

beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR));
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
});

it("serves unbound memory files and the complete diff baseline without opening host SQLite", () =>
  withoutHostSql(async () => {
    await writeFile(path.join(workspace, "example.txt"), "after session\n");
    expect((await files.ok("list")).browser.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "example.txt", sessionKind: "modified" }),
      ]),
    );
    const file = await files.ok("get", "example.txt");
    expect(file.file.content).toBe("after session\n");
    using connection = createSessionFileDownloadClient();
    const download = await files.ok("download", "example.txt", undefined, connection);
    const fetched = await connection.fetch(download.url);
    expect(fetched.response.statusCode).toBe(200);
    expect(Buffer.from(fetched.body as Uint8Array).toString()).toBe("after session\n");
    expect(await files.error("get", "../outside.txt")).toMatchObject({
      details: { reason: "outside_session_boundary" },
    });
    expect(await files.ok("assets", { path: "example.txt", refs: [] })).toEqual({ assets: [] });
    const diff = await loadSessionDiff(
      { sessionKey: key },
      context as GatewayRequestHandlerOptions["context"],
    );
    expect(diff).toMatchObject({ files: [expect.objectContaining({ path: "example.txt" })] });
    const saved = await files.ok("set", {
      path: "example.txt",
      content: "saved\n",
      expectedHash: file.file.hash,
    });
    expect(saved.file).toMatchObject({ path: "example.txt", size: 6 });
    expect(saved.file.hash).not.toBe(file.file.hash);
    expect(await readFile(path.join(workspace, "example.txt"), "utf8")).toBe("saved\n");
    const opened = vi.spyOn(openPath, "execOpenPath").mockResolvedValue(undefined);
    expect(await files.ok("reveal")).toMatchObject({ ok: true, path: workspace });
    expect(opened).toHaveBeenCalledOnce();
  }));

it("keeps MCP file and upload authority on the original actor when a same-ID actor replaces it", () =>
  withoutHostSql(async () => {
    using connection = createSessionFileDownloadClient();
    const options = {
      client: {
        connId: "actor-file-view",
        connect: { role: "operator", scopes: ["operator.admin"] },
        connectionSignal: new AbortController().signal,
      },
      context: { ...context, broadcastToConnIds() {} },
      hasCurrentClientAuthority: () => true,
    } as unknown as GatewayRequestHandlerOptions;
    const resource = {
      uri: "ui://fixture/editor",
      mimeType: "text/html;profile=mcp-app",
      text: "<p>editor</p>",
    };
    const runtime = {
      ...createMcpRuntime(),
      sessionId: sid,
      sessionKey: key,
      readResource: async () => ({ contents: [resource] }),
    };
    const file = await prepareMcpAppHostFile(options, { ...target, path: "example.txt" });
    const upload = createMcpAppWorkspaceUploadProvider({
      workspaceDir: workspace,
      ...target,
      assertCurrent() {},
    });
    const uploadText = (name: string, text: string) =>
      upload({
        options,
        kind: "file",
        files: [{ name, mimeType: "text/plain", data: Buffer.from(text) }],
        assertCurrent() {},
      });
    const descriptor = await fetchMcpAppView({
      runtime,
      agentId: "main",
      serverName: "fixture",
      toolName: "edit",
      uiResourceUri: resource.uri,
      toolInput: {},
      toolResult: { content: [] },
      allowedAppToolNames: new Set(),
      authorizeAppInteraction: () => true,
      hostFile: file,
    });
    assert(descriptor);
    const viewId = descriptor.viewId;
    try {
      const view = getMcpAppViewLease(viewId, runtime);
      assert(view);
      const read = () => readMcpAppHostFile(options, view, { uri: file.resourceUri });
      const download = await files.ok("download", "example.txt", undefined, connection);
      const entered = createDeferred();
      const release = createDeferred();
      const original = workspaceFs.readWorkspaceFile;
      vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
      const reading = read();
      const rejected = expect(reading).rejects.toThrow(/Incognito|incognito/);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          reading,
          "MCP read skipped its file boundary",
        );
        memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
      } finally {
        release.resolve();
        await Promise.allSettled([reading, rejected]);
      }
      await rejected;
      await replaceSessionEntry({ sessionKey: key, storePath }, entry);
      expect((await connection.fetch(download.url)).response.statusCode).toBe(404);
      await expect(read()).rejects.toThrow(/Incognito|incognito/);
      await expect(uploadText("refused.txt", "stale")).rejects.toThrow(/Incognito|incognito/);
    } finally {
      releaseMcpAppView(viewId, runtime);
    }
  }));

it("preserves unbound memory and durable files while an absent memory namespace stays absent", async () => {
  const nativeEnv = { OPENCLAW_STATE_DIR: dirs.make("files-native-control-") };
  const controlStorePath = path.join(
    nativeEnv.OPENCLAW_STATE_DIR,
    "agents/main/sessions/sessions.json",
  );
  const originalCfg = cfg;
  await writeFile(path.join(workspace, "control.txt"), "native control\n");
  setConfig({ ...cfg, session: { store: controlStorePath } });
  try {
    for (const sessionKey of [
      "agent:main:dashboard:incognito-native-files",
      "agent:main:durable-files",
    ]) {
      await replaceSessionEntry(
        { sessionKey, storePath: controlStorePath, env: nativeEnv },
        {
          ...entry,
          sessionId: sessionKey,
          incognito: sessionKey.includes("incognito") ? true : undefined,
        },
      );
      await withEnvAsync(nativeEnv, async () => {
        const ownersBefore = memorySessionActorOwners.list();
        const file = await files.ok("get", { sessionKey, path: "control.txt" });
        expect(file.file.content).toBe("native control\n");
        expect(memorySessionActorOwners.list()).toEqual(ownersBefore);
      });
    }
    const absentEnv = { OPENCLAW_STATE_DIR: dirs.make("files-absent-control-") };
    await withoutHostSql(async () => {
      setConfig({ ...originalCfg });
      await withEnvAsync(absentEnv, async () => {
        const missing = await files.error("get", "example.txt");
        expect(missing).toMatchObject({ details: { type: "session_file_not_found" } });
      });
      expect(
        memorySessionActorOwners.read({
          agentId: "main",
          path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: absentEnv }),
        }),
      ).toBeUndefined();
    });
  } finally {
    memorySessionActorOwners.closeDatabase({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: nativeEnv }),
    });
    setConfig(originalCfg);
  }
});
