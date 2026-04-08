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

type ExpectedExecOverrides = {
  host: "node" | "auto" | "gateway";
  security: "allowlist" | "deny" | "full";
  ask: "always" | "off";
  node: string;
};

const AGENT_EXEC_DEFAULTS = {
  host: "node",
  security: "allowlist",
  ask: "always",
  node: "worker-alpha",
} as const satisfies ExpectedExecOverrides;

const WHATSAPP_EXEC_PROMPT_REQUEST = {
  Body: "run a command",
  From: "+1004",
  To: "+2000",
  Provider: "whatsapp",
  SenderE164: "+1004",
} as const;

const AUTHORIZED_EXEC_DIRECTIVE_REQUEST = {
  From: "+1004",
  To: "+2000",
  CommandAuthorized: true,
} as const;

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
            exec: AGENT_EXEC_DEFAULTS,
          },
        },
      ],
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: sessionStorePath(home) },
  });
}

async function runExecPrompt(home: string) {
  await getReplyFromConfig(WHATSAPP_EXEC_PROMPT_REQUEST, {}, makeAgentExecConfig(home));
}

async function runExecDirective(home: string, body: string) {
  await getReplyFromConfig(
    { ...AUTHORIZED_EXEC_DIRECTIVE_REQUEST, Body: body },
    {},
    makeAgentExecConfig(home),
  );
}

function expectLastExecOverrides(overrides: Partial<ExpectedExecOverrides> = {}) {
  expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
  const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
  expect(call?.execOverrides).toEqual({
    ...AGENT_EXEC_DEFAULTS,
    ...overrides,
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

      await runExecPrompt(home);

      expectLastExecOverrides();
    });
  });

  it("prefers standalone inline exec directives over per-agent exec defaults on the next live run", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await runExecDirective(home, "/exec host=auto");

      runEmbeddedPiAgentMock.mockClear();

      await runExecPrompt(home);

      expectLastExecOverrides({ host: "auto" });
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

      await runExecPrompt(home);

      expectLastExecOverrides({ host: "auto" });
    });
  });

  it("replaces a prior deny override with newer exec settings on later turns", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await runExecDirective(home, "/exec host=gateway security=deny ask=off");

      await runExecDirective(home, "/exec host=gateway security=full ask=always");

      runEmbeddedPiAgentMock.mockClear();

      await runExecPrompt(home);

      expectLastExecOverrides({ host: "gateway", security: "full" });
    });
  });
});
