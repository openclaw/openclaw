// Keep plugin transport proof outside core gateway tests.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../src/agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../src/agents/cli-runner.test-helpers.js";
import { createCliRunCurrentAssertion } from "../src/agents/cli-runner/execution-target.js";
import { prepareCliRunContext } from "../src/agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../src/agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../src/agents/cli-runner/types.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../src/agents/harness/gateway-question.js";
import { withQuestionGateway } from "../src/agents/harness/gateway-question.test-support.js";
import { resetPendingAskUserQuestionsForTest } from "../src/agents/tools/ask-user-tool.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../src/auto-reply/reply/reply-run-registry.contracts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveMcpLoopbackClientGrant } from "../src/gateway/mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import * as toolResolution from "../src/gateway/tool-resolution.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
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
const caller: ReplyToolAuthorityOverlay = {
  messageProvider: "telegram",
  senderIsOwner: true,
  toolsAllow: ["ask_user"],
  disableTools: false,
  traceAuthorized: false,
};

type McpResponse = { result: unknown };
type TelegramRequest = { body: string; url: string };

async function startTelegramAskUserLoopback() {
  const requests: TelegramRequest[] = [];
  const promptRequest = createDeferredCore<TelegramRequest>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        body: Buffer.concat(chunks).toString("utf8"),
        url: request.url ?? "",
      };
      requests.push(entry);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: requests.length,
            date: 1_700_000_000,
            chat: { id: 1, type: "private" },
            text: "ok",
          },
        }),
      );
      if (entry.url.includes("sendMessage")) {
        promptRequest.resolve(entry);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    requests,
    promptRequest: promptRequest.promise,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

beforeEach(() => {
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
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
  });
});

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

it("publishes the prompt through Bot API and completes after the answer", async () => {
  const { telegramPlugin } = await import("../extensions/telegram/api.js");
  const telegram = await startTelegramAskUserLoopback();
  try {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    const cli = createCliRunnerPrepareFixture(prepareCliRunContext);
    const exercise: Parameters<typeof withQuestionGateway>[0] = async (gateway) => {
      const config: OpenClawConfig = {
        ...expectDefined(getRuntimeConfigSnapshot(), "isolated question gateway config"),
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
      setRuntimeConfigSnapshot(config);
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
      let context: PreparedCliRunContext | undefined;
      let admission: PreparedAgentRunAdmission | undefined;
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
          admission = prepareAgentRunAdmission({
            cfg: config,
            facts: {
              runId: captureKey,
              agentId: "main",
              ingress: { kind: "system", boundary: "mcp-question-test", state: "present" },
            },
            operationalRunInstance: createOperationalRunInstanceRef(captureKey),
          });
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
            Promise.race([
              event,
              pending.then(() => {
                throw new Error(`ask_user completed before ${phase}`);
              }),
            ]);
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
              caller,
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
