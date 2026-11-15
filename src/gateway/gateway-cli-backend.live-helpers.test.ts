import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { captureEnv } from "../test-utils/env.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: async (client: { start: () => void }) => {
    client.start();
    return { ready: true, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 0 };
  },
}));

describe("gateway cli backend live helpers", () => {
  const gatewayStartupEnv = captureEnv([...GATEWAY_STARTUP_MUTATED_ENV_KEYS]);
  let liveHelpers: typeof import("./gateway-cli-backend.live-helpers.js");

  beforeAll(async () => {
    liveHelpers = await import("./gateway-cli-backend.live-helpers.js");
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    gatewayStartupEnv.restore();
    cliBackendsTesting.resetDepsForTest();
    for (const key of Object.keys(originalEnv)
      .filter(
        (name) => !["PATH", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_PATH_BOOTSTRAPPED"].includes(name),
      )
      .concat([
        "OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP",
        "OPENCLAW_LIVE_CLI_BACKEND_ADVISORY",
      ])) {
      delete process.env[key];
    }
  });

  const originalEnv = {
    OPENCLAW_SKIP_CHANNELS: "old-channels",
    OPENCLAW_SKIP_PROVIDERS: "old-providers",
    OPENCLAW_SKIP_GMAIL_WATCHER: "old-gmail",
    OPENCLAW_SKIP_CRON: "old-cron",
    OPENCLAW_SKIP_CANVAS_HOST: "old-canvas",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "old-browser",
    OPENCLAW_BUNDLED_PLUGINS_DIR: "old-bundled",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "old-minimal",
    ANTHROPIC_API_KEY: "old-anthropic",
    ANTHROPIC_API_KEY_OLD: "old-anthropic-old",
    PATH: "old-path",
    OPENCLAW_GATEWAY_PORT: "old-port",
    OPENCLAW_PATH_BOOTSTRAPPED: "old-bootstrap",
  };

  it("applies and restores live env including full gateway mode", async () => {
    const { applyCliBackendLiveEnv, restoreCliBackendLiveEnv, snapshotCliBackendLiveEnv } =
      liveHelpers;

    Object.assign(process.env, originalEnv);

    const snapshot = snapshotCliBackendLiveEnv();
    applyCliBackendLiveEnv(new Set<string>());
    process.env.PATH = "gateway-path";
    process.env.OPENCLAW_GATEWAY_PORT = "gateway-port";
    process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

    expect(process.env).toMatchObject({
      ...Object.fromEntries(
        Object.keys(originalEnv)
          .filter((key) => key.startsWith("OPENCLAW_SKIP_"))
          .map((key) => [key, "1"]),
      ),
      OPENCLAW_BUNDLED_PLUGINS_DIR: "old-bundled",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();

    restoreCliBackendLiveEnv(snapshot);

    expect(process.env).toMatchObject(originalEnv);
  });

  it("defaults the model switch probe to Claude Sonnet -> Opus", async () => {
    const { resolveCliModelSwitchProbeTarget, shouldRunCliModelSwitchProbe } = liveHelpers;

    delete process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE;

    expect(resolveCliModelSwitchProbeTarget("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(
      "claude-cli/claude-opus-4-6",
    );
    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(true);
    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-opus-4-6")).toBe(false);
    expect(shouldRunCliModelSwitchProbe("codex-cli", "codex-cli/gpt-5.5")).toBe(false);
  });

  it("rejects removed Codex CLI refs for live CLI backend selection", async () => {
    const { resolveCliBackendLiveModelSelection } = liveHelpers;

    expect(() =>
      resolveCliBackendLiveModelSelection({
        rawModel: "codex-cli/gpt-5.4",
        defaultProvider: "claude-cli",
      }),
    ).toThrow(/codex-cli\/\.\.\. is no longer supported/u);
  });

  it("configures legacy CLI model refs as canonical provider models plus CLI runtime", async () => {
    const { resolveCliBackendLiveModelSelection } = liveHelpers;
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [
          {
            pluginId: "claude",
            backend: {
              id: "claude-cli",
              modelProvider: "anthropic",
              config: { command: "claude", args: [] },
            },
          },
        ],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
    });

    expect(
      resolveCliBackendLiveModelSelection({
        rawModel: "claude-cli/claude-sonnet-4-6",
        defaultProvider: "claude-cli",
        modelSwitchTarget: "claude-cli/claude-opus-4-6",
      }),
    ).toEqual({
      providerId: "claude-cli",
      cliModelKey: "claude-cli/claude-sonnet-4-6",
      configModelKey: "anthropic/claude-sonnet-4-6",
      configModelSwitchTarget: "anthropic/claude-opus-4-6",
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("lets env disable the model switch probe", async () => {
    const { shouldRunCliModelSwitchProbe } = liveHelpers;

    process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE = "0";

    expect(shouldRunCliModelSwitchProbe("claude-cli", "claude-cli/claude-sonnet-4-6")).toBe(false);
  });

  it("requires provider results by default for explicit CLI backend live probes", async () => {
    const {
      CLI_BACKEND_LIVE_ADVISORY_ENV: advisory,
      CLI_BACKEND_LIVE_PROVIDER_SKIP_ENV: skip,
      resolveCliBackendLiveProviderSkipDecision: decision,
      shouldAllowCliBackendLiveProviderSkip: allowsSkip,
    } = liveHelpers;
    const request = { label: "agent request", providerId: "claude-cli" };

    expect(allowsSkip({})).toBe(false);
    expect(
      decision({
        ...request,
        allowProviderSkip: false,
        reasonLabel: "auth drift",
      }),
    ).toEqual({
      action: "fail",
      message:
        'agent request for provider "claude-cli" was blocked by auth drift. Set OPENCLAW_LIVE_CLI_BACKEND_ADVISORY=1 and OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP=1 only for advisory live checks.',
    });

    expect(allowsSkip({ [skip]: "1" })).toBe(false);
    expect(allowsSkip({ [advisory]: "1", [skip]: "1" })).toBe(true);
    expect(
      decision({
        ...request,
        allowProviderSkip: true,
        reasonLabel: "Claude API capacity",
      }),
    ).toEqual({
      action: "skip",
      message: 'agent request for provider "claude-cli" was blocked by Claude API capacity.',
    });
  });

  it("builds Claude continuity prompts without revealing the hidden token", () => {
    const { buildClaudeCliResumeContinuityProbe } = liveHelpers;
    const memoryToken = "test-memory-token";

    const probe = buildClaudeCliResumeContinuityProbe({
      firstTurnNonce: "112233",
      resumeNonce: "445566",
      memoryToken,
    });

    expect(probe.firstTurnPrompt).toContain("public test label");
    expect(probe.firstTurnPrompt).toContain("not a credential");
    expect(probe.firstTurnPrompt).toContain("CLI-BACKEND-112233");
    expect(probe.resumePrompt).toContain("public test label");
    expect(probe.resumePrompt).toContain("CLI-RESUME-445566");
    expect(probe.firstTurnPrompt).not.toContain(memoryToken);
    expect(probe.resumePrompt).not.toContain(memoryToken);
    expect(probe.injectedContext).toContain(memoryToken);
    expect(probe.expectedResumeMarker).toBe("CLI-RESUME-445566");
  });

  it("retries Codex CLI timeout payloads only before the final attempt", async () => {
    const { isCliBackendLiveTimeoutPayload, shouldRetryCliBackendLiveTimeout } = liveHelpers;
    const timeoutPayload = { status: "timeout" };
    const retry = (attempt: number, providerId = "codex-cli") =>
      shouldRetryCliBackendLiveTimeout({
        attempt,
        maxAttempts: 2,
        payload: timeoutPayload,
        providerId,
      });

    expect(isCliBackendLiveTimeoutPayload(timeoutPayload)).toBe(true);
    expect(retry(1)).toBe(true);
    expect(retry(2)).toBe(false);
    expect(retry(1, "claude-cli")).toBe(false);
  });

  it("allows live env overrides for fresh and resume CLI args", async () => {
    const { resolveCliBackendLiveArgs } = liveHelpers;
    const args = ["exec", "--sandbox", "danger-full-access"];
    const resumeArgs = ["exec", "resume", "{sessionId}", "-c", 'sandbox_mode="danger-full-access"'];
    process.env.OPENCLAW_LIVE_CLI_BACKEND_ARGS = JSON.stringify(args);
    process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS = JSON.stringify(resumeArgs);

    expect(
      resolveCliBackendLiveArgs({
        providerId: "codex-cli",
        defaultArgs: ["exec", "--sandbox", "workspace-write"],
        defaultResumeArgs: [
          "exec",
          "resume",
          "{sessionId}",
          "-c",
          'sandbox_mode="workspace-write"',
        ],
      }),
    ).toEqual({ args, resumeArgs });
  });

  it("retries cancelled cron MCP replies", async () => {
    const { shouldRetryCliCronMcpProbeReply } = liveHelpers;
    for (const reply of [
      "The `cron` MCP tool call was cancelled again, so the job was not created.",
      "The cron tool call was cancelled again, so the job still was not created.",
      "The `cron` MCP call was cancelled again, so the job was not created.",
      "The cron tool call was cancelled again, so nothing was created.",
      "The `cron` MCP tool call was cancelled (`user cancelled MCP tool call`).",
      "The tool call was cancelled before completion, so I can’t verify the cron job was created.",
      "The cron tool call was cancelled twice, so I could not create the job.",
      "The cron tool call was cancelled twice, so I couldn’t create `live-mcp-67f4e9`. Please retry and I’ll do it again.",
      "The cron tool call was canceled twice on the host side, so I couldn’t create `live-mcp-2d1afb`. If you want, send the same request again and I’ll retry.",
      "I tried the `cron` tool call twice, but both attempts were canceled by the environment (`user cancelled MCP tool call`), so I can’t honestly reply with the success token.",
      "   ",
      "The cron tool call was cancelled twice, so I couldn’t create `live-mcp-932c6b`. If you want, I can try again.",
    ]) {
      expect(shouldRetryCliCronMcpProbeReply(reply), reply).toBe(true);
    }
    for (const reply of [
      "The cron job was not created because the schedule payload was invalid.",
      "live-mcp-abc123",
    ]) {
      expect(shouldRetryCliCronMcpProbeReply(reply), reply).toBe(false);
    }
  });
});
