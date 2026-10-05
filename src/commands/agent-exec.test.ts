import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AgentRunTerminalOutcomeError } from "../agents/agent-run-terminal-error.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import { enqueueExecutionIdentityContextAtAdmission } from "../audit/execution-identity-admission.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveExecBaseConfig } from "./agent-exec-input.js";
import { classifyAgentExecResult } from "./agent-exec-result.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const externalTempDirs: string[] = [];
const execFileAsync = promisify(execFile);

function successResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 2, total: 12 },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  cleanupTempDirs(externalTempDirs);
});

describe("agent exec strict result classification", () => {
  it.each([
    {
      payload: { text: "provider rejected request", isError: true },
      meta: { durationMs: 10 },
      status: "error",
      kind: "error_payload",
      message: "provider rejected request",
    },
    {
      payload: { isError: true },
      meta: { durationMs: 10 },
      status: "error",
      kind: "error_payload",
      message: "Agent run failed",
    },
    {
      payload: { text: "timed out", isError: true },
      meta: { durationMs: 600_000, aborted: true, stopReason: "timeout" },
      status: "timeout",
      kind: "timeout",
      message: "timed out",
    },
  ])("classifies $message", ({ payload, meta, status, kind, message }) => {
    expect(classifyAgentExecResult({ payloads: [payload], meta })).toMatchObject({
      ok: false,
      status,
      error: { kind, message },
    });
  });

  it("projects only documented payload fields and the outer tool summary", () => {
    const toolSummary = { calls: 2, tools: ["read", "write"], failures: 1, totalToolTimeMs: 25 };
    const envelope = classifyAgentExecResult({
      payloads: [
        {
          text: "done",
          mediaUrl: null,
          audioAsVoice: true,
          presentation: { blocks: [] },
          channelData: { private: true },
        },
      ],
      meta: { durationMs: 10, toolSummary },
    });
    expect(envelope.payloads).toEqual([{ text: "done", mediaUrl: null }]);
    expect(envelope.toolSummary).toEqual(toolSummary);
  });
  it("classifies projected production error payloads as failure", () => {
    const envelope = classifyAgentExecResult(
      successResult("projected error text"),
      false,
      "projected error text",
    );
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      final: "",
      payloads: [{ text: "projected error text", isError: true }],
      error: { kind: "error_payload", message: "projected error text" },
    });
  });

  it("does not restore metadata text for a projected textless error", () => {
    const result = successResult("metadata error text");
    result.payloads = [];
    const envelope = classifyAgentExecResult(result, false, true);
    expect(envelope).toMatchObject({ ok: false, status: "error", final: "", payloads: [] });
  });
});

describe("agent exec command composition", () => {
  it("treats invalid timeout syntax as an ordinary usage error", async () => {
    const runtime = createTestRuntime();

    const result = await runAgentExecWithMock(
      "inspect",
      { timeout: "nope", json: true },
      runtime,
      vi.fn(async () => successResult()),
    );

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: { status: "error", error: { kind: "exception" } },
    });
  });

  it("maps embedded terminal-outcome timeouts to exit code 2", async () => {
    const runtime = createTestRuntime();
    const timeout = new AgentRunTerminalOutcomeError(
      new Error("attempt aborted before prompt submission"),
      {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    );

    const result = await runAgentExecWithMock(
      "inspect",
      { json: true },
      runtime,
      vi.fn(async () => {
        throw timeout;
      }),
    );

    expect(result).toMatchObject({
      exitCode: 2,
      envelope: {
        status: "timeout",
        error: {
          kind: "timeout",
          message: "attempt aborted before prompt submission",
        },
      },
    });
  });

  it("rejects invalid programmatic Code Mode values", async () => {
    const runtime = createTestRuntime();

    const result = await runAgentExecWithMock(
      "inspect",
      { codeMode: "invalid" as never },
      runtime,
      vi.fn(async () => successResult()),
    );

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        status: "error",
        error: { kind: "exception", message: "--code-mode must be one of direct, auto, code." },
      },
    });
  });
  it("writes plain final text to stdout when diagnostics are routed to stderr", async () => {
    const source = `
      import { registerHooks } from "node:module";
      import { agentExecCommand } from "./src/commands/agent-exec.ts";
      import { enableConsoleCapture, routeLogsToStderr } from "./src/logging/console.ts";
      import { defaultRuntime } from "./src/runtime.ts";

      routeLogsToStderr();
      enableConsoleCapture();
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "./agent.js" && context.parentURL?.endsWith("/commands/agent-exec.ts")) {
            return {
              url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(`export const agentCommand = async () => (${JSON.stringify(successResult("india"))});`)}),
              shortCircuit: true,
            };
          }
          return nextResolve(specifier, context);
        },
      });
      const result = await agentExecCommand("inspect", {}, defaultRuntime);
      process.exitCode = result.exitCode;
    `;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
      },
    );

    expect(stdout).toBe("india\n");
    expect(stderr).not.toContain("india");
  });

  it("flushes opted-in identity evidence through its owned direct-local writer", async () => {
    const root = tempDirs.make("openclaw-agent-exec-audit-");
    setRuntimeConfigSnapshot({ logging: { audit: { executionIdentity: true } } });
    const result = await runAgentExecWithMock(
      "inspect",
      { stateDir: root },
      createTestRuntime(),
      async () => {
        expect(
          enqueueExecutionIdentityContextAtAdmission(
            {
              runId: "run",
              agentId: "main",
              ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
              runtime: { kind: "embedded" },
            },
            {
              enabled: true,
              contextId: "context",
              executionId: "execution",
              now: Date.now(),
              runtimeInstanceId: "runtime",
            },
          ),
        ).toMatchObject({ accepted: true });
        return successResult();
      },
    );
    expect(result.exitCode).toBe(0);
    const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      const row = database
        .prepare("SELECT context_json FROM execution_identity_contexts WHERE execution_id = ?")
        .get("execution") as { context_json: string };
      expect(JSON.parse(row.context_json)).toMatchObject({
        contextId: "context",
        executionId: "execution",
        runId: "run",
        ingress: { kind: "local-cli", state: "present" },
      });
    } finally {
      database.close();
    }
  });

  it("keeps operator-installed plugins hidden under --isolated", async () => {
    const operatorStateDir = tempDirs.make("openclaw-agent-exec-plugin-isolated-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: operatorStateDir }, async () => {
      const result = await runAgentExecWithMock(
        "inspect",
        { isolated: true },
        createTestRuntime(),
        async () => {
          const { resolveDefaultPluginExtensionsDir } = await import("../plugins/install-paths.js");
          const extensionsDir = resolveDefaultPluginExtensionsDir();
          expect(extensionsDir).not.toBe(path.join(operatorStateDir, "extensions"));
          expect(path.basename(path.dirname(extensionsDir))).toMatch(/^openclaw-agent-exec-/u);
          return successResult();
        },
      );
      expect(result.exitCode).toBe(0);
    });
  });

  it.each([
    { mode: "direct", configured: true, capability: "preferred", enabled: false },
    { mode: "code", configured: false, capability: "capable", enabled: true },
    { mode: "auto", configured: false, capability: "preferred", enabled: true },
  ] as const)(
    "honors --code-mode $mode over model settings ($capability)",
    async ({ mode, configured, capability, enabled }) => {
      const runtime = createTestRuntime();
      const codeMode = { enabled: configured, maxOutputBytes: 4096 };
      setRuntimeConfigSnapshot({
        agents: {
          defaults: {
            systemAgent: { agentId: "main" },
            models: { "test/model-a": { codeMode: configured } },
          },
          entries: {
            main: { models: { "test/model-a": { codeMode: configured } } },
          },
        },
        tools: { codeMode, toolSearch: false },
      });
      let visibleTools: string[] | undefined;
      try {
        const result = await runAgentExecWithMock(
          "inspect",
          { codeMode: mode, model: "test/model-a", localModelLean: true },
          runtime,
          vi.fn(async (invocation) => {
            const config = expectDefined(getRuntimeConfigSnapshot(), "isolated run config");
            expect(config.tools?.codeMode).toEqual(codeMode);
            expect(config.agents?.defaults?.experimental?.localModelLean).toBe(true);
            const surface = createAgentHarnessToolSurfaceRuntimeCore({
              config,
              agentId: "main",
              modelProvider: "test",
              modelId: "model-a",
              model: { compat: { codeMode: capability } },
              codeModeOverride: invocation.codeModeOverride as boolean | "auto" | undefined,
              modelToolsEnabled: true,
              executeTool: async () => ({ content: [], details: {} }),
            });
            try {
              visibleTools = surface
                .compactTools([createStubTool("read")])
                .tools.map((tool) => tool.name);
            } finally {
              surface.cleanup();
            }
            return successResult();
          }),
        );
        expect(result.exitCode).toBe(0);
        expect(visibleTools).toEqual(enabled ? ["exec", "wait"] : ["read"]);
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it.each([
    { kind: "timeout", status: "timeout", exitCode: 2, thrown: true },
    { kind: "context_overflow", status: "error", exitCode: 1, thrown: false },
  ] as const)("preserves $kind when temporary-state cleanup also fails", async (failure) => {
    const runtime = createTestRuntime();
    const { log, error } = runtime;
    let observedStateDir = "";
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));

    const result = await runAgentExecWithMock("inspect", { json: true }, runtime, async () => {
      observedStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
      if (failure.thrown) {
        throw Object.assign(new Error("original run failure"), {
          name: failure.kind === "timeout" ? "TimeoutError" : "Error",
        });
      }
      return {
        ...successResult("partial answer"),
        meta: { durationMs: 25, error: { kind: failure.kind, message: "original run failure" } },
      };
    });
    externalTempDirs.push(observedStateDir);

    expect(result).toMatchObject({
      exitCode: failure.exitCode,
      envelope: {
        status: failure.status,
        final: failure.thrown ? "" : "partial answer",
        payloads: failure.thrown ? [] : [{ text: "partial answer" }],
        error: { kind: failure.kind, message: "original run failure" },
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(result.envelope);
    expect(error).toHaveBeenCalledWith("original run failure");
    expect(error).toHaveBeenCalledWith("Agent exec cleanup failed: cleanup denied");
  });

  it("classifies cleanup failures before emitting the JSON envelope", async () => {
    const runtime = createTestRuntime();
    const { log } = runtime;
    let observedStateDir = "";
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));

    const result = await runAgentExecWithMock(
      "inspect",
      { json: true },
      runtime,
      vi.fn(async () => {
        observedStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
        return successResult();
      }),
    );
    externalTempDirs.push(observedStateDir);

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        ok: false,
        status: "error",
        error: { kind: "exception", message: "Agent exec cleanup failed: cleanup denied" },
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      status: "error",
      error: { message: "Agent exec cleanup failed: cleanup denied" },
    });
  });

  it("reports exhaustion of the ordered explicit fallback chain", async () => {
    const runtime = createTestRuntime();
    const runAgent = vi.fn(async (opts: Record<string, unknown>) => {
      if (typeof opts.onModelFallbackExhausted !== "function") {
        throw new Error("Missing fallback outcome callback");
      }
      opts.onModelFallbackExhausted();
      return successResult();
    });

    const result = await runAgentExecWithMock(
      "inspect",
      {
        model: "openai/gpt-5.6-sol",
        fallback: ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"],
      },
      runtime,
      runAgent,
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5.6-sol",
        modelFallbacksOverride: ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"],
      }),
      expect.any(Object),
    );
    expect(result).toMatchObject({
      exitCode: 1,
      envelope: { ok: false, status: "error", error: { kind: "fallback_exhausted" } },
    });
  });

  it("undoes environment mutations made by loading the config", async () => {
    const seedDir = tempDirs.make("openclaw-agent-exec-envseed-");
    const seedPath = path.join(seedDir, "openclaw.json");
    await fs.writeFile(
      seedPath,
      JSON.stringify({ env: { vars: { OPENCLAW_EXEC_ENV_PROBE: "from-config" } } }),
      "utf8",
    );
    const runtime = createTestRuntime();
    let observedDuringRun: string | undefined;

    await runAgentExecWithMock(
      "inspect",
      { config: seedPath },
      runtime,
      vi.fn(async () => {
        observedDuringRun = process.env.OPENCLAW_EXEC_ENV_PROBE;
        return successResult();
      }),
    );

    expect(observedDuringRun).toBe("from-config");
    // Config-applied values must not outlive the command, or a later isolated
    // run in the same process would inherit them.
    expect(process.env.OPENCLAW_EXEC_ENV_PROBE).toBeUndefined();
  });
});

describe("agent exec base config resolution", () => {
  it("rejects a missing or invalid pinned config instead of falling back", async () => {
    const missing = path.join(tempDirs.make("openclaw-agent-exec-seed-"), "absent.json");
    await expect(resolveExecBaseConfig({ config: missing })).rejects.toThrow(
      "--config file not found",
    );

    const broken = await writeSeed("{ this is not a config");
    await expect(resolveExecBaseConfig({ config: broken })).rejects.toThrow();
  });

  async function writeSeed(body: string): Promise<string> {
    const dir = tempDirs.make("openclaw-agent-exec-seed-");
    const seedPath = path.join(dir, "openclaw.json");
    await fs.writeFile(seedPath, body, "utf8");
    return seedPath;
  }

  it("reads the pinned file even when a runtime snapshot is already published", async () => {
    const seedPath = await writeSeed(
      `{ // pinned JSON5 config
        models: { providers: { custom: { baseUrl: "https://from-file.invalid", models: [] } } },
      }`,
    );
    setRuntimeConfigSnapshot({
      models: { providers: { custom: { baseUrl: "https://from-snapshot.invalid", models: [] } } },
    });

    try {
      const resolved = await resolveExecBaseConfig({ config: seedPath });
      expect(resolved.models?.providers?.custom?.baseUrl).toBe("https://from-file.invalid");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("rejects --config paired with a mode that reads no config", async () => {
    const seedPath = await writeSeed("{}");

    await expect(resolveExecBaseConfig({ config: seedPath, isolated: true })).rejects.toThrow(
      "--config cannot be combined with --isolated",
    );
    await expect(resolveExecBaseConfig({ config: seedPath, authEnvOnly: true })).rejects.toThrow(
      "--config cannot be combined with --auth-env-only",
    );
  });
});
