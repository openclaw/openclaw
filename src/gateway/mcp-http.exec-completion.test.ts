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
import { setRawCliBackendForPrepareTest } from "../agents/cli-runner/prepare-mcp.test-support.js";
import { prepareCliRunContext } from "../agents/cli-runner/prepare.js";
import * as preparation from "../agents/cli-runner/prepare.test-support.js";
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
import * as testState from "../test-utils/openclaw-test-state.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import * as mcp from "./mcp-http.test-support.js";

type ToolSurface = { native: string[] | undefined; mcp: string[] };
let state: testState.OpenClawTestState;
let config: OpenClawConfig;
const contexts: PreparedCliRunContext[] = [];
const admissions: PreparedAgentRunAdmission[] = [];
const receipts: sessionEvents.SessionEventReceipt[] = [];
const sessionKeys: string[] = [];
const workspacePath = (name: string) => path.join(state.workspaceDir, name);
const expectMissing = (name: string) =>
  expect(fs.stat(workspacePath(name))).rejects.toMatchObject({ code: "ENOENT" });
const writeCommand = (name: string, text: string) => ({
  command: `node -e "require('node:fs').writeFileSync('${name}', '${text}')"`,
});

beforeAll(async () => {
  state = await testState.createOpenClawTestState({
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
  setRawCliBackendForPrepareTest({
    ...buildDefaultTestCliBackend({ bundleMcp: true }),
    id: "claude-cli",
    autoSelectAuthProfile: false,
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "execution-args",
    hostOwnedTools: ["exec", "process", "apply_patch"],
    resolveExecutionArgs: ({ baseArgs }) => baseArgs,
  });
  mcp.setMinimalCliPrepareDeps(preparation.setCliRunnerPrepareTestDeps);
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
  receipts.forEach((receipt) => receipt.cancel());
  await Promise.all(sessionKeys.map((sessionKey) => waitForExecScope(sessionKey)));
  await Promise.all(receipts.map((receipt) => receipt.settled));
  for (const context of contexts) {
    await context.preparedBackend.cleanup?.();
  }
  admissions.forEach((admission) => admission.close());
  await closeMcpLoopbackServer();
  preparation.resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
  await state?.cleanup();
});

async function connectPreparedTurn(context: PreparedCliRunContext, signal: AbortSignal) {
  const { rpc } = await mcp.connectPreparedCliTurn(context, signal);
  return (method: "tools/list" | "tools/call", args?: Record<string, unknown>, name = "exec") =>
    rpc(method, method === "tools/call" ? { name, arguments: args ?? {} } : undefined);
}

async function readToolSurface(context: PreparedCliRunContext, signal: AbortSignal) {
  const response = await (await connectPreparedTurn(context, signal))("tools/list");
  expect(response.status).toBe(200);
  return {
    native: context.params.cliToolAvailability?.native,
    mcp: expectDefined(response.body.result?.tools, "MCP catalog")
      .map((tool) => tool.name)
      .toSorted(),
  } satisfies ToolSurface;
}

it.for<[string, string, string, string, string[] | undefined]>([
  ["no caller cap", "exec-full", "text", "completed", undefined],
  ["a finite caller cap", "exec-capped", "text", "failed", ["exec", "process", "session_status"]],
  ["an empty CLI final", "exec-empty", "empty", "failed", undefined],
  ["a failed CLI final", "exec-failed", "failed", "failed", undefined],
])(
  "retains the CLI surface and enforces completion effects with %s",
  async ([, sessionId, terminal, expectedStatus, toolsAllow], { signal }) => {
    const sessionKey = `agent:main:${sessionId}`;
    const session = { agentId: "main", sessionKey, sessionId };
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
      ...session,
      sessionEntry: entry,
      sessionTarget: {
        ...session,
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
      toolsAllow,
      runId,
      timeoutMs: 60_000,
      abortSignal: signal,
    });
    contexts.push(original);
    const normalSurface = await readToolSurface(original, signal);
    // Ordinary managed Claude turns already use the mediated surface completions require.
    expect(normalSurface).toEqual({
      native: [],
      mcp: toolsAllow ?? expect.arrayContaining(["exec", "session_status"]),
    });

    const completionSurfaces: ToolSurface[] = [];
    // Replace only native model I/O; event dispatch, admission, CLI preparation and MCP stay real.
    const execute = vi
      .spyOn(cliExecution, "executePreparedCliRun")
      .mockImplementation(async (wake) => {
        wake.params.onExecutionPhase?.({ phase: "model_call_started" });
        expect(wake.params.sessionKey).toBe(sessionKey);
        expect(wake.params.prompt).toContain("exec-completion-proof");
        completionSurfaces.push(await readToolSurface(wake, signal));
        const call = await connectPreparedTurn(wake, signal);
        const launches = vi.spyOn(getProcessSupervisor(), "spawn");
        const allowedName = `allowed-${sessionId}.txt`;
        const deniedName = `denied-${sessionId}.txt`;
        try {
          const allowed = await call("tools/call", writeCommand(allowedName, "allowed"));
          expect(allowed).toMatchObject({ status: 200, body: { result: { isError: false } } });
          expect(await fs.readFile(workspacePath(allowedName), "utf8")).toBe("allowed");
          expect(launches).toHaveBeenCalledOnce();
          launches.mockClear();
          if (toolsAllow) {
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
            await expectMissing(deniedName);
            await updateSessionEntry({ agentId: "main", sessionKey }, () => ({
              permissionMode: "read-only",
            }));
            const revoked = await call("tools/call", writeCommand(deniedName, "forbidden"));
            expect(revoked).toEqual({ status: 401, body: { error: "unauthorized" } });
            expect(launches).not.toHaveBeenCalled();
            await expectMissing(deniedName);
          }
        } finally {
          launches.mockRestore();
        }
        if (terminal === "failed") {
          throw new Error("Synthetic CLI provider failure.");
        }
        return { text: terminal === "empty" ? "" : "Completion observed." };
      });
    const receiptIndex = receipts.length;
    try {
      const response = await (
        await connectPreparedTurn(original, signal)
      )("tools/call", {
        command: "echo exec-completion-proof",
        background: true,
      });
      expect(response.status).toBe(200);
      expect(response.body.result).toMatchObject({
        isError: false,
        content: [{ text: expect.stringContaining("Command still running") }],
      });
      await withinTest(waitForExecScope(sessionKey), signal);
      const receipt = expectDefined(receipts[receiptIndex], "background exec completion");
      await expect(withinTest(receipt.accepted, signal)).resolves.toEqual({ ok: true });
      const outcome = await withinTest(receipt.settled, signal);
      expect(outcome).toMatchObject({ status: expectedStatus, executionStarted: true });
      if (expectedStatus === "failed") {
        expect(outcome.error).toBeTruthy();
        expect(outcome).toMatchObject({ delivered: false, deliveryAttempted: false });
      }
      if (toolsAllow) {
        expect(outcome.error).toContain("Session event permissions were restricted");
      }
      expect(completionSurfaces).toEqual([normalSurface]);
    } finally {
      receipts.slice(receiptIndex).forEach((receipt) => receipt.cancel());
      await Promise.all(receipts.slice(receiptIndex).map((receipt) => receipt.settled));
      execute.mockRestore();
    }
  },
);
