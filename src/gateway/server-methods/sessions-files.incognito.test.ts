import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import {
  fetchMcpAppView,
  getMcpAppViewLease,
  releaseMcpAppView,
} from "../../agents/mcp-ui-resource.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { captureSessionDiffBaseline } from "../../sessions/session-diff.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createMcpAppWorkspaceUploadProvider } from "../mcp-app-form-resources.js";
import {
  prepareMcpAppHostFile,
  readMcpAppHostFile,
  writeMcpAppHostFile,
  subscribeMcpAppHostFile,
} from "../mcp-app-host-files.js";
import * as openPath from "./open-path.js";
import { loadSessionDiff } from "./sessions-diff.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  expectOkPayload,
  expectError,
} from "./sessions-files.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import * as workspaceFs from "./workspace-fs.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const key = "agent:main:dashboard:incognito-files";
const sid = "private-files";
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let workspace: string;
let cfg: OpenClawConfig;
let entry: SessionEntry;
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const context = {
  getRuntimeConfig: () => cfg,
  logGateway: createSubsystemLogger("gateway/test/incognito-files"),
};

beforeAll(async () => {
  workspace = dirs.make("incognito-workspace-files-");
  env = { OPENCLAW_STATE_DIR: dirs.make("incognito-files-actor-") };
  cfg = { agents: { entries: { main: { workspace } } }, mcp: { apps: { enabled: true } } };
  setRuntimeConfigSnapshot(cfg);
  actor = await openIncognitoTestActor(env, authority);
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
  await actor.sessions.create(authority, { sessionKey: key, entry });
  const appended = await actor.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey: key,
      sessionId: sid,
      fence: {},
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "write-file", name: "write", arguments: { path: "example.txt" } },
        ],
      },
    },
  });
  assert(appended.ok);
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
});

it("serves bound files and the complete diff baseline without opening host SQLite", async () => {
  await writeFile(path.join(workspace, "example.txt"), "after session\n");
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const list = expectOkPayload(
        await invoke("sessions.files.list", { sessionKey: key }, context),
      );
      expect(list.browser.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "example.txt", sessionKind: "modified" }),
        ]),
      );
      const file = expectOkPayload(
        await invoke("sessions.files.get", { sessionKey: key, path: "example.txt" }, context),
      );
      expect(file.file.content).toBe("after session\n");
      expect(
        expectError(
          await invoke("sessions.files.get", { sessionKey: key, path: "../outside.txt" }, context),
        ),
      ).toMatchObject({ details: { reason: "outside_session_boundary" } });
      expect(
        expectOkPayload(
          await invoke(
            "sessions.files.assets",
            { sessionKey: key, path: "example.txt", refs: [] },
            context,
          ),
        ),
      ).toEqual({ assets: [] });
      expect(
        await loadSessionDiff(
          { sessionKey: key },
          context as GatewayRequestHandlerOptions["context"],
        ),
      ).toMatchObject({ files: [expect.objectContaining({ path: "example.txt" })] });
      const saved = expectOkPayload(
        await invoke(
          "sessions.files.set",
          {
            sessionKey: key,
            path: "example.txt",
            content: "saved\n",
            expectedHash: file.file.hash,
          },
          context,
        ),
      );
      expect(saved.file).toMatchObject({ path: "example.txt", size: 6 });
      expect(saved.file.hash).not.toBe(file.file.hash);
      expect(await readFile(path.join(workspace, "example.txt"), "utf8")).toBe("saved\n");
      const opened = vi.spyOn(openPath, "execOpenPath").mockResolvedValue(undefined);
      expect(
        expectOkPayload(await invoke("sessions.files.reveal", { key }, context)),
      ).toMatchObject({ ok: true, path: workspace });
      expect(opened).toHaveBeenCalledOnce();
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

function mcpOptions(): GatewayRequestHandlerOptions {
  return {
    params: {},
    client: {
      connId: "actor-file-view",
      connect: { role: "operator", scopes: ["operator.admin"] },
      connectionSignal: new AbortController().signal,
    },
    context: { ...context, broadcastToConnIds() {} },
    hasCurrentClientAuthority: () => true,
  } as unknown as GatewayRequestHandlerOptions;
}

it("keeps MCP file and upload authority on the original actor when a same-ID actor replaces it", async () => {
  const options = mcpOptions();
  const runtime = {
    sessionId: sid,
    sessionKey: key,
    mcpAppsEnabled: true,
    markUsed() {},
    readResource: async () => ({
      contents: [
        {
          uri: "ui://fixture/editor",
          mimeType: "text/html;profile=mcp-app",
          text: "<p>editor</p>",
        },
      ],
    }),
  } as unknown as SessionMcpRuntime;
  let viewId: string | undefined;
  const sql = observeHostDataSql();
  try {
    const file = await withIncognitoSessionBinding({ actor }, () =>
      prepareMcpAppHostFile(options, { sessionKey: key, agentId: "main", path: "example.txt" }),
    );
    const upload = withIncognitoSessionBinding({ actor }, () =>
      createMcpAppWorkspaceUploadProvider({
        workspaceDir: workspace,
        sessionKey: key,
        agentId: "main",
        assertCurrent() {},
      }),
    );
    const descriptor = await fetchMcpAppView({
      runtime,
      agentId: "main",
      serverName: "fixture",
      toolName: "edit",
      uiResourceUri: "ui://fixture/editor",
      toolInput: {},
      toolResult: { content: [] },
      allowedAppToolNames: new Set(),
      authorizeAppInteraction: () => true,
      hostFile: file,
    });
    assert(descriptor);
    viewId = descriptor.viewId;
    const view = getMcpAppViewLease(viewId, runtime);
    assert(view);
    // The view and upload callback outlive the initiating actor-binding frame.
    await readMcpAppHostFile(options, view, { uri: file.resourceUri });
    expect(
      await writeMcpAppHostFile(options, view, { uri: file.resourceUri, text: "MCP saved\n" }),
    ).toMatchObject({ outcome: "saved" });
    const uploaded = await upload({
      options,
      kind: "file",
      files: [{ name: "upload.txt", mimeType: "text/plain", data: Buffer.from("uploaded") }],
      assertCurrent() {},
    });
    expect(uploaded).toHaveLength(1);
    expect(await readFile(new URL(uploaded[0]!.uri), "utf8")).toBe("uploaded");
    await subscribeMcpAppHostFile(options, view, file.resourceUri, true);
    const entered = createDeferred();
    const release = createDeferred();
    const original = workspaceFs.readWorkspaceFile;
    vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const reading = readMcpAppHostFile(options, view, { uri: file.resourceUri });
    const rejected = expect(reading).rejects.toThrow(/Incognito|incognito/);
    let closing: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        reading,
        "MCP read skipped its file boundary",
      );
      closing = actor.close();
    } finally {
      release.resolve();
      await Promise.allSettled([reading, rejected, closing]);
    }
    await rejected;
    await closing;
    actor = await openIncognitoTestActor(env, authority);
    await actor.sessions.create(authority, { sessionKey: key, entry });
    await expect(readMcpAppHostFile(options, view, { uri: file.resourceUri })).rejects.toThrow(
      /Incognito|incognito/,
    );
    await expect(
      upload({
        options,
        kind: "file",
        files: [{ name: "refused.txt", mimeType: "text/plain", data: Buffer.from("stale") }],
        assertCurrent() {},
      }),
    ).rejects.toThrow(/Incognito|incognito/);
    expect(sql.queries).toEqual([]);
  } finally {
    if (viewId) {
      releaseMcpAppView(viewId, runtime);
    }
    sql.restore();
  }
});

it("preserves unbound native and durable files while explicit actor absence stays absent", async () => {
  const nativeEnv = { OPENCLAW_STATE_DIR: dirs.make("files-native-control-") };
  const storePath = path.join(
    nativeEnv.OPENCLAW_STATE_DIR,
    "agents",
    "main",
    "sessions",
    "sessions.json",
  );
  const originalCfg = cfg;
  await writeFile(path.join(workspace, "control.txt"), "native control\n");
  cfg = { ...cfg, session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  try {
    for (const sessionKey of [
      "agent:main:dashboard:incognito-native-files",
      "agent:main:durable-files",
    ]) {
      await replaceSessionEntry(
        { sessionKey, storePath, env: nativeEnv },
        {
          ...entry,
          sessionId: sessionKey,
          incognito: sessionKey.includes("incognito") ? true : undefined,
        },
      );
      await withEnvAsync(nativeEnv, async () => {
        expect(captureOpenClawAgentDatabaseExecution.listIncognito(nativeEnv)).toEqual([]);
        const file = expectOkPayload(
          await invoke("sessions.files.get", { sessionKey, path: "control.txt" }, context),
        );
        expect(file.file.content).toBe("native control\n");
        expect(captureOpenClawAgentDatabaseExecution.listIncognito(nativeEnv)).toEqual([]);
      });
    }
    const absentEnv = { OPENCLAW_STATE_DIR: dirs.make("files-absent-control-") };
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionBinding(
        { kind: "absent", agentId: "main", env: absentEnv, authority },
        async () => {
          const missing = expectError(
            await invoke("sessions.files.get", { sessionKey: key, path: "example.txt" }, context),
          );
          expect(missing).toMatchObject({ details: { type: "session_file_not_found" } });
        },
      );
      expect(sql.queries).toEqual([]);
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(absentEnv)).toEqual([]);
    } finally {
      sql.restore();
    }
  } finally {
    cfg = originalCfg;
    setRuntimeConfigSnapshot(cfg);
  }
});
