import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AgentRunTerminalOutcomeError } from "../agents/agent-run-terminal-error.js";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import { enqueueExecutionIdentityContextAtAdmission } from "../audit/execution-identity-admission.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyExecConfigOverrides, resolveExecBaseConfig } from "./agent-exec-input.js";
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

async function writeSeed(
  body: string | OpenClawConfig,
  root = tempDirs.make("openclaw-agent-exec-"),
) {
  const config = path.join(root, "openclaw.json");
  await fs.writeFile(config, typeof body === "string" ? body : JSON.stringify(body));
  return config;
}

function runExec(
  opts: Parameters<typeof runAgentExecWithMock>[1],
  runAgent: Parameters<typeof runAgentExecWithMock>[3] = async () => successResult(),
  runtime = createTestRuntime(),
) {
  return runAgentExecWithMock("inspect", opts, runtime, runAgent);
}

async function runSuccessfulExec(
  opts: Parameters<typeof runExec>[0],
  observe: (invocation: Record<string, unknown>) => void | Promise<void>,
) {
  const result = await runExec(opts, async (invocation) => {
    await observe(invocation);
    return successResult();
  });
  expect(result.exitCode, JSON.stringify(result.envelope.error)).toBe(0);
  return result;
}

function throwFromRun(error: unknown) {
  return runExec({ json: true }, async () => {
    throw error;
  });
}

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  cleanupTempDirs(externalTempDirs);
});

describe("agent exec strict result classification", () => {
  it.each([
    [{ isError: true }, { durationMs: 10 }, "error", "error_payload", "Agent run failed"],
    [
      { text: "timed out", isError: true },
      { durationMs: 600_000, aborted: true, stopReason: "timeout" },
      "timeout",
      "timeout",
      "timed out",
    ],
  ] as const)("classifies %j", (payload, meta, status, kind, message) => {
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
    const message = "projected error text";
    const envelope = classifyAgentExecResult(successResult(message), false, message);
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      final: "",
      payloads: [{ text: message, isError: true }],
      error: { kind: "error_payload", message },
    });
  });
});

describe("agent exec command composition", () => {
  it.each(["ambient", "pinned", "temporary", "isolated"])(
    "selects run storage before agent execution (%s)",
    async (mode) => {
      const root = tempDirs.make("openclaw-agent-exec-storage-");
      const base: OpenClawConfig = {
        database: {
          families: { state: { engine: "postgres" }, agent: { engine: "postgres" } },
          postgres: {
            connection: { source: "env", provider: "default", id: "EXEC_TEST_DSN" },
          },
        },
      };
      const config = await writeSeed(base, root);
      setRuntimeConfigSnapshot(base);
      const retained = mode === "ambient" || mode === "pinned";
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: root,
          EXEC_TEST_DSN: retained ? "postgresql://localhost/exec_test" : undefined,
        },
        async () => {
          await runSuccessfulExec(
            {
              ...(mode !== "temporary" ? { stateDir: root } : {}),
              ...(mode === "pinned" ? { config } : {}),
              ...(mode === "isolated"
                ? { isolated: true, configOverride: [JSON.stringify(base)] }
                : {}),
            },
            () => {
              expect(getDatabaseEngineSelection()?.effectiveEngines.state).toBe(
                retained ? "postgres" : "sqlite",
              );
              expect(getDatabaseEngineSelection()?.effectiveEngines.agent).toBe(
                retained ? "postgres" : "sqlite",
              );
              expect(getRuntimeConfigSnapshot()?.database?.postgres).toEqual(
                retained ? base.database?.postgres : undefined,
              );
            },
          );
        },
      );
    },
  );

  it.each(["ambient", "pinned"])(
    "overlays the %s config for one run without replacing inherited settings",
    async (mode) => {
      const root = tempDirs.make("openclaw-agent-exec-override-");
      const alpha = { model: "custom/model-a", workspace: "/original", skills: ["one"] };
      const custom = { baseUrl: "https://example.invalid", apiKey: "test-key", models: [] };
      const codeMode = { enabled: false, maxOutputBytes: 4096 };
      const base = {
        agents: {
          defaults: { systemAgent: { agentId: "alpha" }, thinkingDefault: "low" },
          entries: { alpha },
        },
        models: { providers: { custom } },
        tools: { deny: ["browser"], codeMode },
      } satisfies OpenClawConfig;
      const original = JSON.stringify(base);
      const configPath = await writeSeed(original, root);
      if (mode === "ambient") {
        setRuntimeConfigSnapshot(base);
      }
      const result = await runSuccessfulExec(
        {
          ...(mode === "pinned" ? { config: configPath } : {}),
          cwd: root,
          model: "explicit/model",
          thinking: "high",
          codeMode: "direct",
          localModelLean: true,
          configOverride: [
            JSON.stringify({
              agents: {
                defaults: {
                  thinkingDefault: "medium",
                  workspace: "/ignored",
                  experimental: { localModelLean: false },
                },
                entries: { alpha: { skills: [], workspace: "/also-ignored" } },
              },
              tools: {
                deny: ["exec"],
                codeMode: { enabled: true },
                exec: { pathPrepend: ["~/.local/bin"] },
              },
            }),
            '{"tools":{"deny":[]}}',
          ],
        },
        async (invocation) => {
          expect(invocation).toMatchObject({
            agentId: "alpha",
            model: "explicit/model",
            thinking: "high",
            codeModeOverride: false,
            operatorDirectRoot: true,
          });
          expect(getRuntimeConfigSnapshot()).toMatchObject({
            agents: {
              defaults: {
                thinkingDefault: "medium",
                workspace: root,
                experimental: { localModelLean: true },
              },
              entries: { alpha: { ...alpha, workspace: root, skills: [] } },
            },
            models: base.models,
            tools: {
              deny: [],
              codeMode: { ...codeMode, enabled: true },
              exec: { pathPrepend: [path.join(os.homedir(), ".local", "bin")] },
            },
          });
        },
      );
      expect(result.envelope.error).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(JSON.stringify(base)).toBe(original);
      expect(getRuntimeConfigSnapshot()).toEqual(mode === "ambient" ? base : null);
    },
  );

  it("restores base-config environment imports when an override fails validation", async () => {
    const config = await writeSeed({
      env: { vars: { OPENCLAW_EXEC_OVERRIDE_PROBE: "from-config" } },
    });
    const runAgent = vi.fn(async () => successResult());
    const result = await runExec(
      { config, configOverride: ['{"tools":{"profile":"invalid"}}'] },
      runAgent,
    );
    expect(result.envelope.error?.message).toContain("Invalid --config-override");
    expect(runAgent).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_EXEC_OVERRIDE_PROBE).toBeUndefined();
  });

  it.each([
    [{ timeout: "nope", json: true }, undefined],
    [{ codeMode: "invalid" as never }, "--code-mode must be one of direct, auto, code."],
  ] as const)("rejects invalid programmatic options %j", async (options, message) => {
    const result = await runExec(options);
    expect(result).toMatchObject({
      exitCode: 1,
      envelope: { status: "error", error: { kind: "exception" } },
    });
    if (message) {
      expect(result.envelope.error?.message).toBe(message);
    }
  });

  it("maps embedded terminal-outcome timeouts to exit code 2", async () => {
    const message = "attempt aborted before prompt submission";
    const result = await throwFromRun(
      new AgentRunTerminalOutcomeError(new Error(message), {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    );
    expect(result).toMatchObject({
      exitCode: 2,
      envelope: { status: "timeout", error: { kind: "timeout", message } },
    });
  });

  it.each([
    [new Error("deadline", { cause: { name: "TimeoutError" } }), 2],
    [new Error("deadline", { cause: Object.assign([], { code: "ETIMEDOUT" }) }), 2],
    [new Error("deadline", { cause: { reason: "timeout" } }), 2],
    [new Error("ordinary failure"), 1],
    [new Error("ordinary failure", { cause: "ETIMEDOUT" }), 1],
    [
      new Error("ordinary failure", {
        cause: { cause: { cause: { cause: { code: "ETIMEDOUT" } } } },
      }),
      1,
    ],
  ] as const)(
    "classifies structured execution errors %j with exit code %s",
    async (error, code) => {
      expect(await throwFromRun(error)).toMatchObject({
        exitCode: code,
        envelope: { status: code === 2 ? "timeout" : "error" },
      });
    },
  );

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
    await runSuccessfulExec({ stateDir: root }, async () => {
      const admission = enqueueExecutionIdentityContextAtAdmission(
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
      );
      expect(admission).toMatchObject({ accepted: true });
    });
    using database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    const row = database
      .prepare("SELECT context_json FROM execution_identity_contexts WHERE execution_id = ?")
      .get("execution") as { context_json: string };
    expect(JSON.parse(row.context_json)).toMatchObject({
      contextId: "context",
      executionId: "execution",
      runId: "run",
      ingress: { kind: "local-cli", state: "present" },
    });
  });

  it("keeps operator-installed plugins hidden under --isolated", async () => {
    const operatorStateDir = tempDirs.make("openclaw-agent-exec-plugin-isolated-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: operatorStateDir }, async () => {
      await runSuccessfulExec({ isolated: true }, async () => {
        const { resolveDefaultPluginExtensionsDir } = await import("../plugins/install-paths.js");
        const extensionsDir = resolveDefaultPluginExtensionsDir();
        expect(extensionsDir).not.toBe(path.join(operatorStateDir, "extensions"));
        expect(path.basename(path.dirname(extensionsDir))).toMatch(/^openclaw-agent-exec-/u);
      });
    });
  });

  it.each([
    { mode: "direct", configured: true, capability: "preferred", enabled: false },
    { mode: "code", configured: false, capability: "capable", enabled: true },
    { mode: "auto", configured: false, capability: "preferred", enabled: true },
  ] as const)(
    "honors --code-mode $mode over model settings ($capability)",
    async ({ mode, configured, capability, enabled }) => {
      const codeMode = { enabled: configured, maxOutputBytes: 4096 };
      const modelSettings = { models: { "test/model-a": { codeMode: configured } } };
      setRuntimeConfigSnapshot({
        agents: {
          defaults: { systemAgent: { agentId: "main" }, ...modelSettings },
          entries: { main: modelSettings },
        },
        tools: { codeMode, toolSearch: false },
      });
      await runSuccessfulExec(
        { codeMode: mode, model: "test/model-a", localModelLean: true },
        async (invocation) => {
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
            expect(
              surface.compactTools([createStubTool("read")]).tools.map((tool) => tool.name),
            ).toEqual(enabled ? ["exec", "wait"] : ["read"]);
          } finally {
            surface.cleanup();
          }
        },
      );
    },
  );

  it("preserves context overflow when temporary-state cleanup also fails", async () => {
    const runtime = createTestRuntime();
    const { log, error } = runtime;
    const runError = { kind: "context_overflow", message: "original run failure" } as const;
    let observedStateDir = "";
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));

    const result = await runExec(
      { json: true },
      async () => {
        observedStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
        return {
          ...successResult("partial answer"),
          meta: { durationMs: 25, error: runError },
        };
      },
      runtime,
    );
    externalTempDirs.push(observedStateDir);

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        status: "error",
        final: "partial answer",
        payloads: [{ text: "partial answer" }],
        error: runError,
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(result.envelope);
    expect(error).toHaveBeenCalledWith(runError.message);
    expect(error).toHaveBeenCalledWith("Agent exec cleanup failed: cleanup denied");
  });

  it("reports exhaustion of the ordered explicit fallback chain", async () => {
    const fallback = ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"];
    const result = await runExec(
      { model: "openai/gpt-5.6-sol", fallback },
      async (opts, runtime) => {
        expect(runtime).toEqual(expect.any(Object));
        expect(opts).toMatchObject({
          model: "openai/gpt-5.6-sol",
          modelFallbacksOverride: fallback,
        });
        if (typeof opts.onModelFallbackExhausted !== "function") {
          throw new Error("Missing fallback outcome callback");
        }
        opts.onModelFallbackExhausted();
        return successResult();
      },
    );
    expect(result).toMatchObject({
      exitCode: 1,
      envelope: { ok: false, status: "error", error: { kind: "fallback_exhausted" } },
    });
  });

  it("applies config environment overrides for the run and restores the original environment", async () => {
    const seedPath = await writeSeed({ env: { vars: { OPENCLAW_EXEC_ENV_PROBE: "from-config" } } });
    await runSuccessfulExec(
      {
        config: seedPath,
        configOverride: ['{"env":{"vars":{"OPENCLAW_EXEC_ENV_PROBE":"from-override"}}}'],
      },
      () => {
        expect(process.env.OPENCLAW_EXEC_ENV_PROBE).toBe("from-override");
      },
    );

    expect(process.env.OPENCLAW_EXEC_ENV_PROBE).toBeUndefined();
  });
});

describe("agent exec base config resolution", () => {
  it.each(["ambient", "pinned"])("loads %s config without opening state", async (mode) => {
    const root = tempDirs.make("openclaw-agent-exec-config-only-");
    const config = await writeSeed({ plugins: { enabled: false } }, root);
    await withEnvAsync({ OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: config }, async () => {
      await resolveExecBaseConfig(mode === "pinned" ? { config } : {});
      await expect(fs.stat(path.join(root, "state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("overlays isolated defaults without inheriting ambient settings", async () => {
    setRuntimeConfigSnapshot({ tools: { profile: "messaging" } });
    const config = await applyExecConfigOverrides(await resolveExecBaseConfig({ isolated: true }), [
      '{"tools":{"deny":["exec"]}}',
    ]);
    expect(config.tools?.deny).toEqual(["exec"]);
    expect(config.tools?.profile).toBeUndefined();
    expect(config.agents?.entries?.main).toBeDefined();
  });

  it.each([
    ["not-json", "must contain valid JSON"],
    ["null", "must be a JSON object"],
    ["[]", "must be a JSON object"],
    ['"text"', "must be a JSON object"],
    ['{"tools":{"profile":"invalid"}}', "Invalid --config-override"],
  ])("rejects invalid override %s", async (value, message) => {
    await expect(applyExecConfigOverrides({}, [value])).rejects.toThrow(message);
  });

  it("rejects overrides with environment-only credentials", async () => {
    await expect(
      resolveExecBaseConfig({ authEnvOnly: true, configOverride: ["{}"] }),
    ).rejects.toThrow("--config-override cannot be combined with --auth-env-only");
  });

  it("rejects a missing or invalid pinned config instead of falling back", async () => {
    const missing = path.join(tempDirs.make("openclaw-agent-exec-seed-"), "absent.json");
    await expect(resolveExecBaseConfig({ config: missing })).rejects.toThrow(
      "--config file not found",
    );

    const broken = await writeSeed("{ this is not a config");
    await expect(resolveExecBaseConfig({ config: broken })).rejects.toThrow();
  });

  it.each(["isolated", "authEnvOnly"] as const)("rejects --config paired with %s", async (mode) => {
    const seedPath = await writeSeed("{}");
    await expect(resolveExecBaseConfig({ config: seedPath, [mode]: true })).rejects.toThrow(
      `--config cannot be combined with --${mode === "isolated" ? mode : "auth-env-only"}`,
    );
  });
});

describe("agent exec tool lifetime", () => {
  it("closes retained tool closures when the invocation ends", async () => {
    const source = vi.fn(async () => ({ content: [], details: {} }));
    let retained: ReturnType<typeof wrapToolWithBeforeToolCallHook> | undefined;
    await runSuccessfulExec({}, () => {
      retained = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
    });
    await expect(retained?.execute("late", {})).rejects.toThrow();
    expect(source).not.toHaveBeenCalled();
  });

  it("retained effect guards cannot borrow a replacement invocation's authority", async () => {
    let retainedGuard: (() => void) | undefined;
    const effect = vi.fn();
    await runSuccessfulExec({}, () => {
      retainedGuard = captureAgentToolSourceExecutionGuard();
    });
    await runSuccessfulExec({}, () => {
      expect(() => {
        retainedGuard?.();
        effect();
      }).toThrow("execution scope is no longer active");
    });
    expect(effect).not.toHaveBeenCalled();
  });
});
