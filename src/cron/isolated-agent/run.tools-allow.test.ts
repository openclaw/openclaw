// Tool allowlist tests cover tool availability for isolated cron runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "../../secrets/runtime-web-tools-state.js";
import {
  hasUsableWebSearchProviderMock,
  loadModelCatalogMock,
  loadRunCronIsolatedAgentTurn,
  resolveConfiguredModelRefMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE =
  "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.";

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
      owner: {
        agentId: "main",
        sessionKey: "agent:main:whatsapp:group:team",
        accountId: "default",
      },
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
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
      scheduledNativePolicy: { version: 1, mode: "disabled" },
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
      },
    } as never,
  };
}

function makeParamsWithDefaultToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
      scheduledNativePolicy: { version: 1, mode: "disabled" },
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
        toolsAllowIsDefault: true,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  jobId?: string;
  toolsAllow?: string[];
  scheduledToolPolicy?: {
    version: 1;
    mode: "account";
    ownerSessionKey: string;
    ownerAccountId: string;
  };
  scheduledNativePolicy?: { version: 1; mode: "inherit" | "disabled" };
} {
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        toolsAllow?: string[];
        scheduledToolPolicy?: {
          version: 1;
          mode: "account";
          ownerSessionKey: string;
          ownerAccountId: string;
        };
        scheduledNativePolicy?: { version: 1; mode: "inherit" | "disabled" };
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
    clearActiveRuntimeWebToolsMetadata();
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
    clearActiveRuntimeWebToolsMetadata();
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "fails closed for capless legacy runs without native provenance",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const result = await runCronIsolatedAgentTurn(makeParams());

      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(result.status).toBe("error");
      expect(result.error).toContain("openclaw doctor --fix");
    },
  );

  it("fails closed when only native provenance is present without a durable tool cap", async () => {
    const params = makeParams();
    (params.job as unknown as { scheduledNativePolicy?: unknown }).scheduledNativePolicy = {
      version: 1,
      mode: "inherit",
    };

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Scheduled authority is missing or invalid");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid persisted scheduled tool policy", async () => {
    const params = makeParamsWithToolsAllow(["cron"]);
    (params.job as { scheduledToolPolicy?: unknown }).scheduledToolPolicy = {
      version: 2,
      mode: "account",
    };

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Scheduled authority is missing or invalid");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("fails closed when an explicit finite cap carries inherited native authority", async () => {
    const params = makeParamsWithToolsAllow(["cron"]);
    (params.job as { scheduledNativePolicy?: unknown }).scheduledNativePolicy = {
      version: 1,
      mode: "inherit",
    };

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Scheduled authority is missing or invalid");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("accepts inherited native authority for a creator-default finite cap", async () => {
    const params = makeParamsWithDefaultToolsAllow(["cron"]);
    (params.job as { scheduledNativePolicy?: unknown }).scheduledNativePolicy = {
      version: 1,
      mode: "inherit",
    };

    await runCronIsolatedAgentTurn(params);

    expect(requireEmbeddedAgentCall().scheduledNativePolicy).toEqual({
      version: 1,
      mode: "inherit",
    });
  });

  it(
    "keeps capped accountless legacy jobs on the ordinary sender-policy path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["cron"]);
      delete (params.job as { owner?: { accountId?: string } }).owner?.accountId;
      delete (params.job as { scheduledToolPolicy?: unknown }).scheduledToolPolicy;

      await runCronIsolatedAgentTurn(params);

      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["cron"]);
      expect(call.scheduledToolPolicy).toBeUndefined();
    },
  );

  it(
    "passes through isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(["cron"]);
      expect(call.scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      });
      expect(call.scheduledNativePolicy).toEqual({ version: 1, mode: "disabled" });
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
    "adds cron diagnostics when web_search is allowed without a selected provider",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["web_search"]);
      expect(result.diagnostics?.summary).toBe(MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE);
      expect(result.diagnostics?.entries).toEqual([
        {
          ts: expect.any(Number),
          source: "cron-preflight",
          severity: "warn",
          message: MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
          toolName: "web_search",
        },
      ]);
    },
  );

  it(
    "uses the prepared provider selected from a plugin-scoped web search key",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      setActiveRuntimeWebToolsMetadata({
        search: {
          providerSource: "auto-detect",
          selectedProvider: "brave",
          selectedProviderKeySource: "config",
          diagnostics: [],
        },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      });
      const cfg = {
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: { apiKey: "token-oversized" },
              },
            },
          },
        },
      };

      const result = await runCronIsolatedAgentTurn({
        ...makeParamsWithToolsAllow(["web_search"]),
        cfg,
      });

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
      expect(hasUsableWebSearchProviderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: "/tmp/agent-dir",
          preferRuntimeProviders: true,
          runtimeWebSearch: expect.objectContaining({ selectedProvider: "brave" }),
        }),
      );
    },
  );

  it(
    "does not warn for default-derived toolsAllow that includes web_search",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const result = await runCronIsolatedAgentTurn(
        makeParamsWithDefaultToolsAllow(["web_search"]),
      );

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
    },
  );

  it(
    "does not warn when native web_search suppresses the managed provider tool",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      resolveConfiguredModelRefMock.mockReturnValue({
        provider: "gateway",
        model: "gpt-5.5",
      });
      loadModelCatalogMock.mockResolvedValue([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "gateway",
          api: "openai-chatgpt-responses",
        },
      ]);

      const result = await runCronIsolatedAgentTurn({
        ...makeParamsWithToolsAllow(["web_search"]),
        cfg: {
          tools: {
            web: {
              search: {
                enabled: true,
                openaiCodex: {
                  enabled: true,
                  mode: "cached",
                },
              },
            },
          },
        },
      });

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
    },
  );

  it(
    "keeps web_search provider diagnostics when the run aborts",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      runWithModelFallbackMock.mockResolvedValueOnce({
        result: {
          payloads: [],
          meta: {
            aborted: true,
            agentMeta: {},
          },
        },
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      });

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("error");
      expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
        MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
        "cron isolated agent run aborted",
      ]);
    },
  );
});
