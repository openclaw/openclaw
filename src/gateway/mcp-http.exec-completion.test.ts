import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../agents/cli-runner.test-helpers.js";
import * as cliExecution from "../agents/cli-runner/execute.js";
import { createCliRunCurrentAssertion } from "../agents/cli-runner/execution-target.js";
import { prepareCliRunContext } from "../agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import "../auto-reply/dispatch.js";
import { prewarmConfigDrivenReplyRuntime } from "../auto-reply/reply/get-reply-from-config.runtime.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
};

type ToolSurface = { native: string[] | undefined; mcp: string[] };
let state: OpenClawTestState;
let config: OpenClawConfig;
const contexts: PreparedCliRunContext[] = [];
const admissions: PreparedAgentRunAdmission[] = [];
const receipts: sessionEvents.SessionEventReceipt[] = [];
const sessionKeys: string[] = [];

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mcp-exec-completion-",
    layout: "state-only",
    env: {
      OPENCLAW_TEST_FAST: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    },
  });
  config = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "claude-cli/sonnet" },
      },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    tools: {
      allow: ["exec", "process", "apply_patch", "session_status"],
      codeMode: false,
      toolSearch: false,
      exec: { host: "gateway", security: "full", ask: "off" },
    },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  openOpenClawStateDatabase();
  setActivePluginRegistry(createEmptyPluginRegistry());
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        id: "claude-cli",
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        hostOwnedTools: ["exec", "process", "apply_patch"],
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
  });
  const enqueue = sessionEvents.enqueueSessionEventForHost;
  vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((...args) => {
    const receipt = enqueue(...args);
    receipts.push(receipt);
    return receipt;
  });
  await ensureMcpLoopbackServer();
  await prewarmConfigDrivenReplyRuntime();
});

afterAll(async () => {
  for (const receipt of receipts) {
    receipt.cancel();
  }
  await Promise.all(sessionKeys.map((sessionKey) => waitForExecScope(sessionKey)));
  await Promise.all(receipts.map((receipt) => receipt.settled));
  for (const context of contexts) {
    await context.preparedBackend.cleanup?.();
  }
  for (const admission of admissions) {
    admission.close();
  }
  await closeMcpLoopbackServer();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
  await state?.cleanup();
});

function connectPreparedTurn(context: PreparedCliRunContext, signal: AbortSignal) {
  const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "isolated MCP runtime");
  const token = expectDefined(context.preparedBackend.env?.OPENCLAW_MCP_TOKEN, "CLI grant");
  const captureKey = `capture-${context.params.runId}`;
  context.preparedBackend.mcpClientGrantCapture?.activate(
    captureKey,
    createCliRunCurrentAssertion(context.params),
  );
  return async (
    method: "tools/list" | "tools/call",
    args?: Record<string, unknown>,
    toolName = "exec",
  ) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-openclaw-cli-capture-key": captureKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(method === "tools/call" ? { params: { name: toolName, arguments: args } } : {}),
      }),
    });
    return { status: response.status, body: (await response.json()) as McpResponse };
  };
}

async function readToolSurface(context: PreparedCliRunContext, signal: AbortSignal) {
  const response = await connectPreparedTurn(context, signal)("tools/list");
  expect(response.status).toBe(200);
  return {
    native: context.params.cliToolAvailability?.native,
    mcp: expectDefined(response.body.result?.tools, "MCP catalog")
      .map((tool) => tool.name)
      .toSorted(),
  } satisfies ToolSurface;
}

it.for([
  { name: "unrestricted native tools", toolsAllow: undefined },
  { name: "a finite caller cap", toolsAllow: ["exec", "process", "session_status"] },
])(
  "retains the CLI surface and enforces completion effects with $name",
  async (source, { signal }) => {
    const sessionId = source.toolsAllow ? "exec-capped" : "exec-full";
    const sessionKey = `agent:main:${sessionId}`;
    sessionKeys.push(sessionKey);
    const entry = {
      sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full" as const,
    };
    await replaceSessionEntry({ agentId: "main", sessionKey }, entry);
    const runId = `${sessionId}-source`;
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "exec-completion-test");
    admissions.push(admission);
    const original = await prepareCliRunContext({
      preparedRunAdmission: admission,
      config,
      agentId: "main",
      sessionKey,
      sessionId,
      sessionEntry: entry,
      sessionTarget: {
        agentId: "main",
        sessionKey,
        sessionId,
        storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
      },
      sessionFile: state.path(`${sessionId}.jsonl`),
      workspaceDir: state.workspaceDir,
      cwd: state.workspaceDir,
      provider: "claude-cli",
      model: "sonnet",
      modelHasVision: false,
      prompt: "Run the background command and continue after completion.",
      skillsSnapshot: { prompt: "", skills: [] },
      senderIsOwner: true,
      toolsAllow: source.toolsAllow,
      runId,
      timeoutMs: 60_000,
      abortSignal: signal,
    });
    contexts.push(original);
    const normalSurface = await readToolSurface(original, signal);
    expect(normalSurface.mcp).toContain("exec");
    expect(normalSurface.mcp).toContain("session_status");
    expect(normalSurface.native).toEqual(source.toolsAllow ? [] : undefined);
    if (source.toolsAllow) {
      expect(normalSurface.mcp).toEqual(["exec", "process", "session_status"]);
    }

    const completionSurfaces: ToolSurface[] = [];
    // Replace only native model I/O; event dispatch, admission, CLI preparation and MCP stay real.
    const execute = vi
      .spyOn(cliExecution, "executePreparedCliRun")
      .mockImplementation(async (wake) => {
        wake.params.onExecutionPhase?.({ phase: "model_call_started" });
        expect(wake.params.sessionKey).toBe(sessionKey);
        expect(wake.params.prompt).toContain("exec-completion-proof");
        completionSurfaces.push(await readToolSurface(wake, signal));
        const call = connectPreparedTurn(wake, signal);
        const launches = vi.spyOn(getProcessSupervisor(), "spawn");
        const allowedName = `allowed-${sessionId}.txt`;
        const deniedName = `denied-${sessionId}.txt`;
        try {
          const allowed = await call("tools/call", {
            command: `node -e "require('node:fs').writeFileSync('${allowedName}', 'allowed')"`,
          });
          expect(allowed.status).toBe(200);
          expect(allowed.body.result?.isError).toBe(false);
          expect(await fs.readFile(path.join(state.workspaceDir, allowedName), "utf8")).toBe(
            "allowed",
          );
          expect(launches).toHaveBeenCalledOnce();
          launches.mockClear();
          if (source.toolsAllow) {
            const forbidden = await call(
              "tools/call",
              { input: `*** Begin Patch\n*** Add File: ${deniedName}\n+forbidden\n*** End Patch` },
              "apply_patch",
            );
            expect(forbidden.status).toBe(200);
            expect(forbidden.body.result).toMatchObject({
              isError: true,
              content: [{ type: "text", text: "Tool not available: apply_patch" }],
            });
            await expect(fs.stat(path.join(state.workspaceDir, deniedName))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await updateSessionEntry({ agentId: "main", sessionKey }, () => ({
              permissionMode: "read-only",
            }));
            const revoked = await call("tools/call", {
              command: `node -e "require('node:fs').writeFileSync('${deniedName}', 'forbidden')"`,
            });
            expect(revoked.status).toBe(401);
            expect(revoked.body).toEqual({ error: "unauthorized" });
            expect(launches).not.toHaveBeenCalled();
            await expect(fs.stat(path.join(state.workspaceDir, deniedName))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        } finally {
          launches.mockRestore();
        }
        return { text: "Completion observed." };
      });
    const receiptIndex = receipts.length;
    try {
      const response = await connectPreparedTurn(original, signal)("tools/call", {
        command: "echo exec-completion-proof",
        background: true,
      });
      expect(response.status).toBe(200);
      expect(response.body.result).toMatchObject({
        isError: false,
        content: [
          expect.objectContaining({ text: expect.stringContaining("Command still running") }),
        ],
      });
      await withinTest(waitForExecScope(sessionKey), signal);
      const receipt = expectDefined(receipts[receiptIndex], "background exec completion");
      await expect(withinTest(receipt.accepted, signal)).resolves.toEqual({ ok: true });
      await expect(withinTest(receipt.settled, signal)).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
      });
      expect(completionSurfaces).toEqual([normalSurface]);
    } finally {
      for (const receipt of receipts.slice(receiptIndex)) {
        receipt.cancel();
      }
      await Promise.all(receipts.slice(receiptIndex).map((receipt) => receipt.settled));
      execute.mockRestore();
    }
  },
);
