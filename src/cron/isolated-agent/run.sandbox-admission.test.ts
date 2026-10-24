import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../agents/cli-runner.test-helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ScheduledOccurrence } from "../scheduled-occurrence.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../scheduled-occurrence.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import * as harness from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
const actualFallbackRunner = await vi.importActual<
  typeof import("../../agents/model-fallback-runner.js")
>("../../agents/model-fallback-runner.js");
const actualCliRunner = await vi.importActual<typeof import("../../agents/cli-runner.js")>(
  "../../agents/cli-runner.js",
);

const sessionId = "cron-sandbox-admission-session";
const tempRoots: string[] = [];

function createRealCliStubExecutable(dir: string) {
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
  return { commandPath, markerPath };
}
type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];

describe("cron isolated-agent sandbox placement admission", () => {
  let previousFastTestEnv: string | undefined;
  let tempDir: string;
  let commandPath: string;
  let markerPath: string;
  function run(
    defaults: AgentDefaults,
    model?: string,
    sessionKey = "existing-cron-session",
    agentModel?: string,
    child?: { occurrence: ScheduledOccurrence },
  ) {
    const cfg: OpenClawConfig = {
      session: { store: path.join(tempDir, "sessions.json") },
      agents: {
        defaults,
        entries: {
          main: { workspace: tempDir, ...(agentModel ? { subagents: { model: agentModel } } : {}) },
        },
      },
    };
    return runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        agentId: "main",
        sessionKey,
        message: "summarize",
        ...(child ? { occurrence: child.occurrence } : {}),
        job: makeIsolatedAgentJobFixture({
          agentId: "main",
          sessionTarget: child ? "isolated" : `session:${sessionKey}`,
          payload: { kind: "agentTurn", message: "summarize", ...(model ? { model } : {}) },
        }),
      }),
    );
  }
  function setSession(sandbox?: "required") {
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({
        storePath: path.join(tempDir, "sessions.json"),
        sessionEntry: harness.makeCronSessionEntry({ sessionId, ...(sandbox ? { sandbox } : {}) }),
        isNewSession: true,
      }),
    );
  }
  function expectSandboxRejection(result: Awaited<ReturnType<typeof run>>) {
    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(fs.existsSync(markerPath)).toBe(false);
  }

  beforeEach(() => {
    previousFastTestEnv = harness.clearFastTestEnv();
    harness.resetRunCronIsolatedAgentTurnHarness();
    harness.resolveAgentConfigMock.mockImplementation(
      (cfg: OpenClawConfig, id: string) => cfg.agents?.entries?.[id],
    );
    harness.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "<available_skills></available_skills>",
      skills: [],
      resolvedSkills: [],
      version: 42,
    });
    const acquireRuntime = expectDefined(
      harness.acquirePreparedModelRuntimeMock.getMockImplementation(),
      "runtime fixture",
    );
    harness.acquirePreparedModelRuntimeMock.mockImplementation(async (input, options) => {
      const lease = await acquireRuntime(input, options);
      return { ...lease, snapshot: { ...lease.snapshot, isCurrent: () => true } };
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
    harness.isCliProviderMock.mockImplementation((provider: string) => provider === "test-cli");
    harness.resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-test",
    });
    harness.resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw?: string }) => {
      if (raw?.startsWith("test-cli/")) {
        return { ref: { provider: "test-cli", model: raw.slice("test-cli/".length) } } as never;
      }
      if (raw?.startsWith("anthropic/")) {
        return { ref: { provider: "anthropic", model: raw.slice("anthropic/".length) } } as never;
      }
      return { ref: { provider: "openai", model: "gpt-test" } } as never;
    });
    harness.resolveThinkingDefaultMock.mockReturnValue("off");
    setSession();
    // Exercise the real fallback loop and real runCliAgent child-process launch.
    harness.runWithModelFallbackMock.mockImplementation((params) =>
      actualFallbackRunner.runWithModelFallback({
        ...params,
        skipAuthProfileRuntime: true,
      }),
    );
    harness.runCliAgentMock.mockImplementation((params) => actualCliRunner.runCliAgent(params));
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    cleanupTempDirs(tempRoots);
    harness.restoreFastTestEnv(previousFastTestEnv);
  });

  it.each<{
    name: string;
    defaults: AgentDefaults;
    model?: string;
    required?: boolean;
    fallback?: boolean;
  }>([
    {
      name: "inherited CLI default",
      defaults: { sandbox: { mode: "all" }, subagents: { model: "test-cli/claude-x" } },
    },
    {
      name: "CLI fallback",
      defaults: {
        sandbox: { mode: "all" },
        subagents: { model: { primary: "openai/gpt-test", fallbacks: ["test-cli/claude-x"] } },
      },
      fallback: true,
    },
    {
      name: "API model with CLI runtime",
      defaults: {
        sandbox: { mode: "all" },
        subagents: { model: "anthropic/claude-sonnet-4-6" },
        models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "test-cli" } } },
      },
    },
    {
      name: "explicit CLI payload",
      defaults: { sandbox: { mode: "all" } },
      model: "test-cli/claude-x",
    },
    {
      name: "required session isolation",
      defaults: { subagents: { model: "test-cli/claude-x" } },
      required: true,
    },
  ])(
    "fails closed for $name before CLI launch",
    async ({ defaults, model, required, fallback }) => {
      if (required) {
        setSession("required");
      }
      if (fallback) {
        harness.runEmbeddedAgentMock.mockRejectedValueOnce(
          new FailoverError("primary rate limited", {
            reason: "rate_limit",
            provider: "openai",
            model: "gpt-test",
            status: 429,
          }),
        );
      }
      const result = await run(defaults, model);
      expectSandboxRejection(result);
      expect(result.error).toContain("agents.entries.<id>.subagents.model");
      expect(harness.runEmbeddedAgentMock).toHaveBeenCalledTimes(fallback ? 1 : 0);
    },
  );

  // The root row predates the parent's requirement; only the occurrence carries it.
  function useExistingUnstampedRoot() {
    // A persisted root keeps its row: creation metadata applies only to new rows.
    replaceSessionEntrySync(
      { sessionKey: "agent:main:cron:test-job", storePath: path.join(tempDir, "sessions.json") },
      { sessionId, updatedAt: Date.now() },
    );
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({
        storePath: path.join(tempDir, "sessions.json"),
        sessionEntry: harness.makeCronSessionEntry({ sessionId }),
        isNewSession: false,
      }),
    );
  }
  const childOf = (sandbox?: "required"): { occurrence: ScheduledOccurrence } => ({
    occurrence: {
      ...TEST_SCHEDULED_OCCURRENCE,
      childParent: { ...(sandbox ? { sandbox } : {}), assertCurrent: () => {} },
    },
  });
  const cliDefaults: AgentDefaults = { subagents: { model: "test-cli/claude-x" } };

  it("fails closed before CLI launch for an existing unstamped root whose parent requires a sandbox", async () => {
    useExistingUnstampedRoot();
    expectSandboxRejection(
      await run(cliDefaults, undefined, undefined, undefined, childOf("required")),
    );
  });

  it("launches the CLI for an existing root whose parent does not require a sandbox", async () => {
    useExistingUnstampedRoot();
    const result = await run(cliDefaults, undefined, undefined, undefined, childOf());
    expect([result.status, result.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("admits a sandboxed session when per-agent subagents.model overrides the global CLI default", async () => {
    const result = await run(
      { sandbox: { mode: "all" }, subagents: { model: "test-cli/claude-x" } },
      undefined,
      undefined,
      "openai/gpt-test",
    );
    expect([result.status, result.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("launches the real CLI process for permitted unsandboxed sessions", async () => {
    const result = await run({ subagents: { model: "test-cli/claude-x" } });
    expect([result.status, result.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, "utf8")).toContain("launched:");
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("rejects non-main cron sessions under sandbox mode non-main while permitting main-session CLI execution", async () => {
    const defaults: AgentDefaults = {
      sandbox: { mode: "non-main" },
      subagents: { model: "test-cli/claude-x" },
    };
    expectSandboxRejection(await run(defaults));
    setSession();
    const mainResult = await run(defaults, undefined, "agent:main:main");
    expect([mainResult.status, mainResult.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
