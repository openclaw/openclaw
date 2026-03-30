import "./reply.directive.directive-behavior.e2e-mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEST_MODEL_CATALOG,
  installDirectiveBehaviorE2EHooks,
  installFreshDirectiveBehaviorReplyMocks,
  makeEmbeddedTextResult,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import {
  loadModelCatalogMock,
  runEmbeddedPiAgentMock,
} from "./reply.directive.directive-behavior.e2e-mocks.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;

function makeAgentExecConfig(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: `${home}/openclaw`,
      },
      list: [
        {
          id: "main",
          tools: {
            exec: {
              host: "node" as const,
              security: "allowlist" as const,
              ask: "always" as const,
              node: "worker-alpha",
            },
          },
        },
      ],
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: sessionStorePath(home) },
  };
}

describe("directive behavior exec agent defaults", () => {
  installDirectiveBehaviorE2EHooks();

  beforeEach(async () => {
    vi.resetModules();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
    installFreshDirectiveBehaviorReplyMocks();
    ({ getReplyFromConfig } = await import("./reply.js"));
  });

  it("threads per-agent tools.exec defaults into live runs without a persisted session override", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await getReplyFromConfig(
        {
          Body: "run a command",
          From: "+1004",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1004",
        },
        {},
        makeAgentExecConfig(home),
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.execOverrides).toEqual({
        host: "node",
        security: "allowlist",
        ask: "always",
        node: "worker-alpha",
      });
    });
  });
});
