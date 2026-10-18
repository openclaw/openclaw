import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../agents/cli-runner.test-helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import {
  acquirePreparedModelRuntimeMock,
  buildWorkspaceSkillSnapshotMock,
  clearFastTestEnv,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  preparedRunPluginRegistryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveThinkingDefaultMock,
  restoreFastTestEnv,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const actualFallbackRunner = await vi.importActual<
  typeof import("../../agents/model-fallback-runner.js")
>("../../agents/model-fallback-runner.js");
const actualCliRunner = await vi.importActual<typeof import("../../agents/cli-runner.js")>(
  "../../agents/cli-runner.js",
);

const sessionId = "cron-sandbox-admission-session";
const tempRoots: string[] = [];

function createRealCliStubExecutable(dir: string): {
  commandPath: string;
  markerPath: string;
} {
  const commandPath = path.join(dir, "test-cli-bin.sh");
  const markerPath = path.join(dir, "cli-launched.marker");
  fs.writeFileSync(
    commandPath,
    [
      "#!/bin/sh",
      `printf 'launched:%s\\n' "$*" >> ${JSON.stringify(markerPath)}`,
      "printf 'real cli stub output\\n'",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.chmodSync(commandPath, 0o755);
  return { commandPath, markerPath };
}

function makeSandboxAdmissionParams(
  cfg: OpenClawConfig,
  workspaceDir: string,
  payload?: { model?: string; fallbacks?: string[] },
  sessionKey = "existing-cron-session",
): RunCronAgentTurnParams {
  const mergedCfg: OpenClawConfig = {
    ...cfg,
    session: { ...cfg.session, store: path.join(workspaceDir, "sessions.json") },
    agents: {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        main: {
          workspace: workspaceDir,
          ...cfg.agents?.entries?.main,
        },
      },
    },
  };
  setRuntimeConfigSnapshot(mergedCfg);
  resolveAgentConfigMock.mockImplementation(
    (config: OpenClawConfig | undefined, agentId: string) =>
      config?.agents?.entries?.[agentId] ?? mergedCfg.agents?.entries?.[agentId],
  );
  return {
    deliveryAttemptFence: null,
    cfg: mergedCfg,
    deps: {},
    agentId: "main",
    job: {
      id: "sandbox-admission-job",
      name: "Sandbox admission",
      agentId: "main",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: `session:${sessionKey}`,
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "summarize",
        ...(payload?.model ? { model: payload.model } : {}),
        ...(payload?.fallbacks ? { fallbacks: payload.fallbacks } : {}),
      },
      state: {},
    },
    message: "summarize",
    sessionKey,
  };
}

describe("cron isolated-agent sandbox placement admission", () => {
  let previousFastTestEnv: string | undefined;
  let tempDir: string;
  let commandPath: string;
  let markerPath: string;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "<available_skills></available_skills>",
      skills: [],
      resolvedSkills: [],
      version: 42,
    });
    acquirePreparedModelRuntimeMock.mockImplementation(async (input, options) => {
      const registry = preparedRunPluginRegistryMock();
      const metadata =
        options?.pluginGeneration?.pluginMetadataSnapshot ??
        options?.pluginMetadataSnapshot ??
        createPluginMetadataSnapshotFixture();
      return {
        snapshot: {
          ...input,
          metadataSnapshot: metadata,
          pluginRegistry: registry,
          isCurrent: () => true,
        },
        pluginGeneration: {
          ...options?.pluginGeneration,
          pluginMetadataSnapshot: metadata,
          pluginRegistry: registry,
        },
        [Symbol.asyncDispose]: vi.fn(async () => {}),
      };
    });
    tempDir = makeTempDir(tempRoots, "cron-sandbox-admission-");
    ({ commandPath, markerPath } = createRealCliStubExecutable(tempDir));
    const backend = {
      ...buildDefaultTestCliBackend(),
      modelProvider: "anthropic",
    };
    backend.config.command = commandPath;
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: (() => [backend]) as never,
    });
    isCliProviderMock.mockImplementation((provider: string) => provider === "test-cli");
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-test" });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw?: string }) => {
      if (raw?.startsWith("test-cli/")) {
        return { ref: { provider: "test-cli", model: raw.slice("test-cli/".length) } } as never;
      }
      if (raw?.startsWith("anthropic/")) {
        return { ref: { provider: "anthropic", model: raw.slice("anthropic/".length) } } as never;
      }
      return { ref: { provider: "openai", model: "gpt-test" } } as never;
    });
    resolveThinkingDefaultMock.mockReturnValue("off");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: path.join(tempDir, "sessions.json"),
        sessionEntry: makeCronSessionEntry({ sessionId }),
        isNewSession: true,
      }),
    );
    // Exercise the real fallback loop and real runCliAgent child-process launch.
    runWithModelFallbackMock.mockImplementation((params) =>
      actualFallbackRunner.runWithModelFallback({
        ...params,
        skipAuthProfileRuntime: true,
      }),
    );
    runCliAgentMock.mockImplementation((params) => actualCliRunner.runCliAgent(params));
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    cleanupTempDirs(tempRoots);
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("fails closed when a sandboxed session inherits a CLI-backed subagent default before process launch", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all" }, subagents: { model: "test-cli/claude-x" } },
      },
    };
    const result = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(result.error).toContain("agents.entries.<id>.subagents.model");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("fails closed when a sandboxed session falls back to a CLI-backed candidate", async () => {
    runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("primary rate limited", {
        reason: "rate_limit",
        provider: "openai",
        model: "gpt-test",
        status: 429,
      }),
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all" },
          subagents: {
            model: {
              primary: "openai/gpt-test",
              fallbacks: ["test-cli/claude-x"],
            },
          },
        },
      },
    };
    const result = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("fails closed when a sandboxed session routes an API model to a CLI runtime override", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all" },
          subagents: { model: "anthropic/claude-sonnet-4-6" },
          models: {
            "anthropic/claude-sonnet-4-6": {
              agentRuntime: { id: "test-cli" },
            },
          },
        },
      },
    };
    const result = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("fails closed for an explicit CLI payload model in a sandboxed session", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all" } } },
    };
    const result = await runCronIsolatedAgentTurn(
      makeSandboxAdmissionParams(cfg, tempDir, { model: "test-cli/claude-x" }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("fails closed when the session entry carries required sandbox isolation", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { subagents: { model: "test-cli/claude-x" } } },
    };
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: path.join(tempDir, "sessions.json"),
        sessionEntry: makeCronSessionEntry({ sessionId, sandbox: "required" }),
        isNewSession: true,
      }),
    );
    const result = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("admits a sandboxed session when per-agent subagents.model overrides the global CLI default", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all" }, subagents: { model: "test-cli/claude-x" } },
        entries: {
          main: {
            workspace: tempDir,
            subagents: { model: "openai/gpt-test" },
          },
        },
      },
    };
    const result = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ok");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("launches the real CLI process for permitted unsandboxed sessions", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { subagents: { model: "test-cli/claude-x" } } },
    };
    const result = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ok");
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, "utf8")).toContain("launched:");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("rejects non-main cron sessions under sandbox mode non-main while permitting main-session CLI execution", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "non-main" }, subagents: { model: "test-cli/claude-x" } },
      },
    };
    const nonMainResult = await runCronIsolatedAgentTurn(makeSandboxAdmissionParams(cfg, tempDir));

    expect(nonMainResult.status).toBe("error");
    expect(nonMainResult.error).toContain("cannot honor the sandbox");
    expect(fs.existsSync(markerPath)).toBe(false);

    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: path.join(tempDir, "sessions.json"),
        sessionEntry: makeCronSessionEntry({ sessionId }),
        isNewSession: true,
      }),
    );
    const mainResult = await runCronIsolatedAgentTurn(
      makeSandboxAdmissionParams(cfg, tempDir, undefined, "agent:main:main"),
    );

    expect(mainResult.error).toBeUndefined();
    expect(mainResult.status).toBe("ok");
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
