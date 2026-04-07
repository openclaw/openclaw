import fs from "node:fs/promises";
import "./reply.directive.directive-behavior.e2e-mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEST_MODEL_CATALOG,
  MAIN_SESSION_KEY,
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
import { withFullRuntimeReplyConfig } from "./reply/get-reply-fast-path.js";

let getReplyFromConfig: typeof import("./reply/get-reply.js").getReplyFromConfig;

function makeAgentExecConfig(home: string) {
  return withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
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
  });
}

describe("directive behavior exec agent defaults", () => {
  installDirectiveBehaviorE2EHooks();

  beforeEach(async () => {
    vi.resetModules();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
    installFreshDirectiveBehaviorReplyMocks();
    ({ getReplyFromConfig } = await import("./reply/get-reply.js"));
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

  it("prefers standalone inline exec directives over per-agent exec defaults on the next live run", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await getReplyFromConfig(
        {
          Body: "/exec host=auto",
          From: "+1004",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeAgentExecConfig(home),
      );

      runEmbeddedPiAgentMock.mockClear();

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
        host: "auto",
        security: "allowlist",
        ask: "always",
        node: "worker-alpha",
      });
    });
  });

  it("prefers persisted session exec overrides over per-agent exec defaults", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));
      await fs.writeFile(
        sessionStorePath(home),
        JSON.stringify({
          [MAIN_SESSION_KEY]: {
            sessionId: "main",
            updatedAt: Date.now(),
            execHost: "auto",
          },
        }),
        "utf-8",
      );

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
        host: "auto",
        security: "allowlist",
        ask: "always",
        node: "worker-alpha",
      });
    });
  });
});
