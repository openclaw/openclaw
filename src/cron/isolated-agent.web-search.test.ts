import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../agents/test-helpers/fast-coding-tools.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  const legacySecretRef = {
    source: "env",
    provider: "default",
    id: "LEGACY_WEB_SEARCH_REF",
  } as const;
  return {
    cfg: {
      tools: {
        web: {
          search: {
            apiKey: legacySecretRef,
          },
        },
      },
    },
    deps: {} as never,
    job: {
      id: "web-search",
      name: "Web Search",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "search status",
        toolsAllow: ["web_search"],
      },
      delivery: { mode: "none" },
    } as never,
    message: "search status",
    sessionKey: "cron:web-search",
    lane: "cron",
    legacySecretRef,
  };
}

function requireEmbeddedPiAgentParams(): {
  toolsAllow?: string[];
  config?: {
    tools?: {
      web?: {
        search?: {
          apiKey?: unknown;
        };
      };
    };
  };
} {
  const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw new Error("Expected embedded PI agent params for isolated web_search cron");
  }
  return call;
}

describe("runCronIsolatedAgentTurn web_search legacy config (#81538)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("forwards web_search toolsAllow with legacy top-level search credential config", async () => {
    const { legacySecretRef, ...params } = makeParams();

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);

    const embeddedParams = requireEmbeddedPiAgentParams();
    expect(embeddedParams.toolsAllow).toEqual(["web_search"]);
    expect(embeddedParams.config?.tools?.web?.search?.apiKey).toEqual(legacySecretRef);
  });
});
