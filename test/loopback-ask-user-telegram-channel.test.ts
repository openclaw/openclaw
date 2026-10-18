// Keep plugin transport proof outside core gateway tests.
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import * as registries from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../src/agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../src/agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../src/agents/cli-runner.test-helpers.js";
import { createCliRunCurrentAssertion } from "../src/agents/cli-runner/execution-target.js";
import { prepareCliRunContext } from "../src/agents/cli-runner/prepare.js";
import * as prepareDeps from "../src/agents/cli-runner/prepare.test-support.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../src/agents/harness/gateway-question.js";
import { withQuestionGateway } from "../src/agents/harness/gateway-question.test-support.js";
import { resetPendingAskUserQuestionsForTest } from "../src/agents/tools/ask-user-tool.test-support.js";
import * as runtimeConfig from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveMcpLoopbackClientGrant } from "../src/gateway/mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import * as toolResolution from "../src/gateway/tool-resolution.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { awaitGateBeforeSettlement } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

vi.mock("../src/plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
vi.mock("../src/tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const sessionKey = "agent:main:telegram:direct:1";
const captureKey = "loopback-ask-user-telegram";
const question = {
  id: "choice",
  header: "Choice",
  question: "Which destination should be used?",
  options: [{ label: "Staging" }, { label: "Production" }],
};

type McpResponse = { result: unknown };
type TelegramRequest = { body: string; url: string };

async function startTelegramAskUserLoopback() {
  const requests: TelegramRequest[] = [];
  const promptRequest = createDeferredCore<TelegramRequest>();
  const server = createServer((request, response) => {
    void text(request)
      .then((body) => {
        const entry = { body, url: request.url ?? "" };
        requests.push(entry);
        response.writeHead(200, { "content-type": "application/json" });
        const result = { message_id: requests.length, chat: { id: 1, type: "private" } };
        response.end(JSON.stringify({ ok: true, result }));
        if (entry.url.includes("sendMessage")) {
          promptRequest.resolve(entry);
        }
      })
      .catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    requests,
    promptRequest: promptRequest.promise,
    close: async () => {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
  };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  prepareDeps.resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  registries.resetPluginRuntimeStateForTest();
  registries.setActivePluginRegistry(registries.createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

it("publishes the prompt through Bot API and completes after the answer", async () => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      },
    ],
  });
  prepareDeps.setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    loadManifestModelCatalog: () => [],
  });
  const { telegramPlugin } = await import("../extensions/telegram/api.js");
  const telegram = await startTelegramAskUserLoopback();
  try {
    registries.setActivePluginRegistry(
      registries.createTestRegistry([
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
      ]),
    );
    const cli = createCliRunnerPrepareFixture(prepareCliRunContext);
    const exercise: Parameters<typeof withQuestionGateway>[0] = async (gateway) => {
      const config: OpenClawConfig = {
        ...expectDefined(
          runtimeConfig.getRuntimeConfigSnapshot(),
          "isolated question gateway config",
        ),
        agents: { defaults: { workspace: cli.session.dir }, entries: { main: {} } },
        plugins: { enabled: false },
        tools: { profile: "full" },
        channels: {
          telegram: {
            botToken: "123456:loopback-ask-user",
            apiRoot: telegram.apiRoot,
          },
        },
      };
      runtimeConfig.setRuntimeConfigSnapshot(config);
      await ensureMcpLoopbackServer();
      const { getActiveMcpLoopbackRuntime } =
        await import("../src/gateway/mcp-http.loopback-runtime.js");
      const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "loopback runtime");
      const toolCalls: Promise<unknown>[] = [];
      const resolveTools = toolResolution.resolveGatewayScopedTools;
      const resolutions = vi
        .spyOn(toolResolution, "resolveGatewayScopedTools")
        .mockImplementation(async (...args) => {
          const scoped = await resolveTools(...args);
          for (const tool of scoped.tools) {
            const execute = tool.execute;
            vi.spyOn(tool, "execute").mockImplementation((...executeArgs) => {
              const pending = execute(...executeArgs);
              toolCalls.push(pending);
              return pending;
            });
          }
          return scoped;
        });
      const requestController = new AbortController();
      let context: Awaited<ReturnType<typeof cli.prepare>> | undefined;
      let admission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
      let pendingResponse: Promise<McpResponse> | undefined;
      const request = async (token: string, method: "tools/list" | "tools/call") => {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          signal: requestController.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-openclaw-cli-capture-key": captureKey,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            ...(method === "tools/call"
              ? { params: { name: "ask_user", arguments: { questions: [question] } } }
              : {}),
          }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as McpResponse;
      };
      await runQaGatewayFixture(
        async () => {
          admission = prepareSystemAgentRunAdmission(
            config,
            captureKey,
            "main",
            "mcp-question-test",
          );
          context = await cli.prepare({
            config,
            preparedRunAdmission: admission,
            sessionKey,
            runId: captureKey,
            timeoutMs: 60_000,
            abortSignal: new AbortController().signal,
            messageProvider: "telegram",
            currentChannelId: "1",
            agentAccountId: "default",
            senderIsOwner: true,
            toolsAllow: ["ask_user"],
          });
          const token = expectDefined(
            context.preparedBackend.env?.OPENCLAW_MCP_TOKEN,
            "prepared CLI grant",
          );
          context.preparedBackend.mcpClientGrantCapture?.activate(
            captureKey,
            createCliRunCurrentAssertion(context.params),
          );
          expect(
            resolveMcpLoopbackClientGrant({
              token,
              runtimeOwnerToken: runtime.ownerToken,
              captureKey,
            })?.isCurrent(),
          ).toBe(true);
          await request(token, "tools/list");
          const registration = gateway.holdRegistration();
          const pending = request(token, "tools/call");
          pendingResponse = pending;
          void pending.catch(() => {});
          const beforeCompletion = <T>(event: Promise<T>, phase: string) =>
            awaitGateBeforeSettlement(event, pending, `ask_user completed before ${phase}`);
          try {
            await beforeCompletion(registration.entered, "question registration");
          } finally {
            registration.release();
          }
          const prompt = await beforeCompletion(telegram.promptRequest, "Telegram prompt delivery");
          expect(prompt.body).toContain("Which destination should be used?");
          expect(prompt.body).toContain("Staging");
          await expect(
            claimPendingAgentQuestionAnswerFromCaller({
              sessionKey,
              text: "Staging",
              caller: {
                messageProvider: "telegram",
                senderIsOwner: true,
                toolsAllow: ["ask_user"],
                disableTools: false,
                traceAuthorized: false,
              },
              persist: vi.fn(async () => {}),
              assertSourceCurrent: () => {},
            }),
          ).resolves.toBe(true);
          const completed = await pending;
          expect(
            telegram.requests.filter((entry) => entry.url.includes("sendMessage")),
          ).toHaveLength(1);
          expect(completed.result).toMatchObject({
            isError: false,
            content: [{ type: "text", text: expect.stringContaining('"status": "answered"') }],
          });
        },
        () => {
          requestController.abort();
          for (const pendingQuestion of gateway.manager.list()) {
            gateway.manager.cancel(pendingQuestion.id, "test-cleanup");
          }
        },
        () => Promise.allSettled(pendingResponse ? [pendingResponse] : []),
        () => closeMcpLoopbackServer(),
        () => Promise.allSettled(toolCalls),
        () => context?.preparedBackend.cleanup?.(),
        () => admission?.close(),
        () => resolutions.mockRestore(),
      );
    };
    await runQaGatewayFixture(
      () => withQuestionGateway(exercise),
      () => closeOpenClawStateDatabaseForTest(),
      () => cli.cleanup(),
    );
  } finally {
    await telegram.close();
  }
});
