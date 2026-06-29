// Tool allowlist tests cover tool availability for isolated cron runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  listWebSearchProvidersMock,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCodexNativeSearchActivationMock,
  resolveDeliveryTargetMock,
  resolveWebSearchProviderIdMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_TOOLS_ALLOW_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check allowed tools" },
      delivery: { mode: "none" },
    } as never,
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
  };
}

function makeParamsWithToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  jobId?: string;
  toolsAllow?: string[];
} {
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        toolsAllow?: string[];
      }
    | undefined;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call for toolsAllow passthrough");
  }
  return call;
}

describe("runCronIsolatedAgentTurn toolsAllow passthrough", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "forum",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "passes through isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(["cron"]);
    },
  );

  it(
    "preserves cron toolsAllow casing for downstream policy resolution",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow([" CRON "]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual([" CRON "]);
    },
  );

  it(
    "passes through non-cron toolsAllow entries",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["maniple__check_idle_workers"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["maniple__check_idle_workers"]);
    },
  );

  it(
    "adds a warning diagnostic when web_search is allowed but no provider is enabled",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      listWebSearchProvidersMock.mockReturnValue([]);

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(resolveWebSearchProviderIdMock).toHaveBeenCalledWith({
        config: expect.any(Object),
        agentDir: "/tmp/agent-dir",
        providers: [],
      });
      expect(result.diagnostics?.summary).toContain(
        "web_search is in toolsAllow but no web search provider is selected or available",
      );
      expect(result.diagnostics?.entries).toContainEqual({
        ts: expect.any(Number),
        source: "cron-preflight",
        severity: "warn",
        message:
          "web_search is in toolsAllow but no web search provider is selected or available. Enable or configure one with: openclaw plugins enable duckduckgo",
        toolName: "web_search",
      });
    },
  );

  it(
    "adds a warning diagnostic when web_search has providers but no selected provider",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      listWebSearchProvidersMock.mockReturnValue([{ id: "duckduckgo" }]);
      resolveWebSearchProviderIdMock.mockReturnValue("");

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(result.diagnostics?.summary).toContain(
        "web_search is in toolsAllow but no web search provider is selected or available",
      );
    },
  );

  it(
    "keeps cron execution non-fatal when web_search availability diagnostics fail",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      listWebSearchProvidersMock.mockImplementation(() => {
        throw new Error("provider registry unavailable");
      });

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(result.diagnostics?.entries).toContainEqual({
        ts: expect.any(Number),
        source: "cron-preflight",
        severity: "warn",
        message: "provider registry unavailable",
        toolName: "web_search",
      });
    },
  );

  it(
    "does not warn when web_search has a selected provider",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      listWebSearchProvidersMock.mockReturnValue([{ id: "duckduckgo" }]);
      resolveWebSearchProviderIdMock.mockReturnValue("duckduckgo");

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
    },
  );

  it(
    "does not warn when native OpenAI/Codex hosted web_search is active for the resolved model",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      listWebSearchProvidersMock.mockReturnValue([]);
      resolveWebSearchProviderIdMock.mockReturnValue("");
      resolveCodexNativeSearchActivationMock.mockReturnValue({ state: "native_active" });

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
    },
  );
});
