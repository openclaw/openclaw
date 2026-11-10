import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../agents/cli-runner.test-helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ScheduledOccurrence } from "../scheduled-occurrence.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../scheduled-occurrence.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
const actualFallbackRunner = await vi.importActual<
  typeof import("../../agents/model-fallback-runner.js")
>("../../agents/model-fallback-runner.js");
const actualCliRunner = await vi.importActual<typeof import("../../agents/cli-runner.js")>(
  "../../agents/cli-runner.js",
);

const sessionId = "cron-sandbox-admission-session";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];

describe("cron isolated-agent sandbox placement admission", () => {
  setupRunCronIsolatedAgentTurnSuite();
  let tempDir: string;
  let markerPath: string;
  function run(
    defaults: AgentDefaults,
    options: {
      model?: string;
      sessionKey?: string;
      agentModel?: string;
      occurrence?: ScheduledOccurrence;
    } = {},
  ) {
    const { model, sessionKey = "existing-cron-session", agentModel, occurrence } = options;
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
        ...(occurrence ? { occurrence } : {}),
        job: makeIsolatedAgentJobFixture({
          agentId: "main",
          sessionTarget: occurrence ? "isolated" : `session:${sessionKey}`,
          payload: { kind: "agentTurn", message: "summarize", ...(model ? { model } : {}) },
        }),
      }),
    );
  }
  function setSession(sandbox?: "required", isNewSession = true) {
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({
        storePath: path.join(tempDir, "sessions.json"),
        sessionEntry: harness.makeCronSessionEntry({ sessionId, ...(sandbox ? { sandbox } : {}) }),
        isNewSession,
      }),
    );
  }
  function expectSandboxRejection(result: Awaited<ReturnType<typeof run>>) {
    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot honor the sandbox");
    expect(fs.existsSync(markerPath)).toBe(false);
  }

  beforeEach(() => {
    harness.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "<available_skills></available_skills>",
      skills: [],
      resolvedSkills: [],
      version: 42,
    });
    harness.resolveAgentConfigMock.mockImplementation(
      (cfg: OpenClawConfig, id: string) => cfg.agents?.entries?.[id],
    );
    const acquireRuntime = expectDefined(
      harness.acquirePreparedModelRuntimeMock.getMockImplementation(),
      "runtime fixture",
    );
    harness.acquirePreparedModelRuntimeMock.mockImplementation(async (input, options) => {
      const lease = await acquireRuntime(input, options);
      return { ...lease, snapshot: { ...lease.snapshot, isCurrent: () => true } };
    });
    tempDir = tempDirs.make("cron-sandbox-admission-");
    const commandPath = path.join(tempDir, "test-cli-bin.sh");
    markerPath = path.join(tempDir, "cli-launched.marker");
    fs.writeFileSync(
      commandPath,
      [
        "#!/bin/sh",
        `printf 'launched:%s\\n' "$*" >> ${JSON.stringify(markerPath)}`,
        "printf 'real cli stub output\\n'",
      ].join("\n"),
      { mode: 0o755 },
    );
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

  afterEach(() => cliBackendsTesting.resetDepsForTest());

  const cliDefaults: AgentDefaults = { subagents: { model: "test-cli/claude-x" } };
  it.each<[string, AgentDefaults, { model?: string; required?: boolean; fallback?: boolean }]>([
    ["inherited CLI default", { sandbox: { mode: "all" }, ...cliDefaults }, {}],
    [
      "CLI fallback",
      {
        sandbox: { mode: "all" },
        subagents: { model: { primary: "openai/gpt-test", fallbacks: ["test-cli/claude-x"] } },
      },
      { fallback: true },
    ],
    [
      "API model with CLI runtime",
      {
        sandbox: { mode: "all" },
        subagents: { model: "anthropic/claude-sonnet-4-6" },
        models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "test-cli" } } },
      },
      {},
    ],
    ["explicit CLI payload", { sandbox: { mode: "all" } }, { model: "test-cli/claude-x" }],
    ["required session isolation", cliDefaults, { required: true }],
  ])(
    "fails closed for %s before CLI launch",
    async (_name, defaults, { model, required, fallback }) => {
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
      const result = await run(defaults, { model });
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
    setSession(undefined, false);
  }
  const childOf = (sandbox?: "required"): ScheduledOccurrence => ({
    ...TEST_SCHEDULED_OCCURRENCE,
    childParent: { ...(sandbox ? { sandbox } : {}), assertCurrent: () => {} },
  });

  it("fails closed before CLI launch for an existing unstamped root whose parent requires a sandbox", async () => {
    useExistingUnstampedRoot();
    expectSandboxRejection(await run(cliDefaults, { occurrence: childOf("required") }));
  });

  it("launches the CLI for an existing root whose parent does not require a sandbox", async () => {
    useExistingUnstampedRoot();
    const result = await run(cliDefaults, { occurrence: childOf() });
    expect([result.status, result.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, "utf8")).toContain("launched:");
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("admits a sandboxed session when per-agent subagents.model overrides the global CLI default", async () => {
    const result = await run(
      { sandbox: { mode: "all" }, ...cliDefaults },
      { agentModel: "openai/gpt-test" },
    );
    expect([result.status, result.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("rejects non-main cron sessions under sandbox mode non-main while permitting main-session CLI execution", async () => {
    const defaults: AgentDefaults = {
      sandbox: { mode: "non-main" },
      ...cliDefaults,
    };
    expectSandboxRejection(await run(defaults));
    setSession();
    const mainResult = await run(defaults, { sessionKey: "agent:main:main" });
    expect([mainResult.status, mainResult.error]).toEqual(["ok", undefined]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
