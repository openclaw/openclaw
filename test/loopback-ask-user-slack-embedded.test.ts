/**
 * Production-composition proof: a callback-less requester-settle embedded attempt
 * constructs ask_user with its channel fallback and reaches Slack's real Web API adapter.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../src/agents/admitted-run-context.js";
import { createAttemptSetupFixture } from "../src/agents/embedded-agent-runner/run/attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "../src/agents/embedded-agent-runner/run/attempt-tool-prepare.js";
import type { RunEmbeddedAgentParams } from "../src/agents/embedded-agent-runner/run/params.js";
import { createEmbeddedRunProgressController } from "../src/agents/embedded-agent-runner/run/progress-controller.js";
import type { EmbeddedRunAttemptParams } from "../src/agents/embedded-agent-runner/run/types.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../src/agents/harness/gateway-question.js";
import { withQuestionGateway } from "../src/agents/harness/gateway-question.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../src/agents/harness/tool-authority.runtime.js";
import { resetPendingAskUserQuestionsForTest } from "../src/agents/tools/ask-user-tool.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../src/auto-reply/reply/reply-run-registry.contracts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

vi.mock("../src/plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
vi.mock("../src/tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:slack:channel:C_ORIGIN:thread:171234.567";
const runId = "announce:requester-settle:main:yield-slack-loopback";
const questionArgs = {
  questions: [
    {
      id: "choice",
      header: "Destination",
      question: "Which destination should be used?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};
const caller: ReplyToolAuthorityOverlay = {
  originatingChannel: "slack",
  messageProvider: "slack",
  agentAccountId: "origin",
  senderIsOwner: true,
  toolsAllow: ["ask_user"],
  disableTools: false,
  traceAuthorized: false,
};

type SlackRequest = {
  authorization: string | undefined;
  body: string;
  method: string | undefined;
  url: string;
};

type SlackLoopback = {
  apiUrl: string;
  requests: SlackRequest[];
  promptRequest: Promise<SlackRequest>;
  close: () => Promise<void>;
};

async function startSlackLoopback(): Promise<SlackLoopback> {
  const requests: SlackRequest[] = [];
  const promptRequest = createDeferredCore<SlackRequest>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        url: request.url ?? "",
      };
      requests.push(entry);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          channel: "C_ORIGIN",
          ts: "171234.568",
          message: { text: "Question for you:" },
        }),
      );
      if (entry.url === "/api/chat.postMessage") {
        promptRequest.resolve(entry);
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${port}/api/`,
    requests,
    promptRequest: promptRequest.promise,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("callback-less embedded ask_user through Slack", () => {
  it("delivers, answers once, and resumes on the originating account and thread", async () => {
    const slack = await startSlackLoopback();
    const tempRoot = tempDirs.make("openclaw-slack-ask-user-");
    vi.stubEnv("SLACK_API_URL", slack.apiUrl);
    for (const key of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_PROXY_CA_FILE",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
    vi.stubEnv("no_proxy", "127.0.0.1,localhost");
    try {
      const { slackPlugin } = await import("../extensions/slack/api.js");
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "slack", plugin: slackPlugin, source: "test" }]),
      );
      await withQuestionGateway(async (gateway) => {
        const config: OpenClawConfig = {
          ...getRuntimeConfigSnapshot(),
          agents: { list: [{ id: "main", default: true, workspace: tempRoot }] },
          tools: { profile: "full" },
          channels: {
            slack: {
              botToken: "xoxb-wrong-root",
              accounts: {
                origin: { botToken: "xoxb-origin-loopback" },
                wrong: { botToken: "xoxb-wrong-account" },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(config);
        const admission = prepareSystemAgentRunAdmission(
          config,
          runId,
          "main",
          "callback-less-slack-ask-user-proof",
        );
        try {
          const admittedRunContext = await admission.admit("embedded");
          const outerAttempt = {
            config,
            runId,
            sessionId: "requester-settle-session",
            sessionKey,
            sessionFile: path.join(tempRoot, "session.jsonl"),
            agentId: "main",
            workspaceDir: tempRoot,
            messageChannel: "slack",
            messageProvider: "slack",
            messageTo: "C_ORIGIN",
            currentMessagingTarget: "C_WRONG_TARGET",
            currentChannelId: "C_WRONG_CHANNEL",
            agentAccountId: "origin",
            messageThreadId: "171234.567",
            currentThreadTs: "999999.000",
            sourceReplyDeliveryMode: "message_tool_only",
            senderIsOwner: true,
          } as unknown as RunEmbeddedAgentParams;
          expect(outerAttempt.onToolResult).toBeUndefined();
          const progress = createEmbeddedRunProgressController({
            attempt: outerAttempt,
            noteLaneTaskProgress: () => {},
            startedAtMs: Date.now(),
          });

          // run-attempt-dispatch forwards this exact progress callback into the attempt.
          // Undefined is what lets attempt-tool-prepare install the channel fallback.
          const attempt = {
            ...outerAttempt,
            admittedRunContext,
            model: {
              id: "loopback-model",
              name: "Loopback model",
              api: "openai-responses",
              provider: "openai",
              input: ["text"],
              contextWindow: 16_000,
              maxTokens: 2_048,
            },
            modelId: "loopback-model",
            provider: "openai",
            toolsAllow: ["ask_user"],
            disableTools: false,
            onToolResult: progress.notifyToolResult,
          } as unknown as EmbeddedRunAttemptParams;
          await withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext },
            attempt,
            undefined,
            async (authorizedAttempt) => {
              const runAbortController = new AbortController();
              const prepared = await prepareEmbeddedAttemptToolBase({
                agentDir: tempRoot,
                attempt: authorizedAttempt,
                setup: createAttemptSetupFixture({
                  effectiveCwd: tempRoot,
                  effectiveWorkspace: tempRoot,
                  resolvedWorkspace: tempRoot,
                  sessionPermissionRoot: tempRoot,
                  sandboxSessionKey: sessionKey,
                  sessionAgentId: "main",
                }),
                markCoreToolStage: () => {},
                onYield: () => {},
                runAbortController,
                runTrace: { traceId: "11111111111111111111111111111111" },
                skillUsagePaths: undefined,
                skillsSnapshot: undefined,
                codeModeSkills: [],
                toolSearchCatalogExecutor: async () => {
                  throw new Error("tool search is not expected in this proof");
                },
              });
              try {
                const askUser = prepared.toolsRaw.find((tool) => tool.name === "ask_user");
                expect(askUser, "real createOpenClawCodingTools ask_user").toBeDefined();
                const persist = vi.fn(async () => {});
                const toolResult = askUser!.execute("ask-user-slack-loopback", questionArgs);
                let promptTimeout: NodeJS.Timeout | undefined;
                const prompt = await Promise.race([
                  slack.promptRequest,
                  toolResult.then(() => {
                    throw new Error("ask_user completed before Slack prompt delivery");
                  }),
                  new Promise<never>((_resolve, reject) => {
                    promptTimeout = setTimeout(
                      () =>
                        reject(
                          new Error(
                            "Slack prompt was not delivered through callback-less embedded fallback",
                          ),
                        ),
                      1_500,
                    );
                  }),
                ]).finally(() => clearTimeout(promptTimeout));

                expect(slack.requests).toHaveLength(1);
                expect(prompt).toMatchObject({
                  authorization: "Bearer xoxb-origin-loopback",
                  method: "POST",
                  url: "/api/chat.postMessage",
                });
                const form = new URLSearchParams(prompt.body);
                expect(form.get("channel")).toBe("C_ORIGIN");
                expect(form.get("thread_ts")).toBe("171234.567");
                expect(form.get("text")).toContain("Which destination should be used?");
                const blocks = JSON.parse(form.get("blocks") ?? "null") as unknown;
                expect(blocks).toEqual([
                  {
                    type: "section",
                    text: { type: "mrkdwn", text: "Which destination should be used?" },
                  },
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "- Staging\n- Production\n\nReply with the number, the option text, or your own answer.",
                    },
                  },
                  {
                    type: "actions",
                    block_id: "openclaw_reply_buttons_1",
                    elements: [
                      {
                        action_id: "openclaw:question_button:1:1",
                        type: "button",
                        text: { emoji: true, text: "Staging", type: "plain_text" },
                        value: "slq1:ask_b7fe13e099650f4f17a001ae5eecf8bf:0",
                      },
                      {
                        action_id: "openclaw:question_button:1:2",
                        type: "button",
                        text: { emoji: true, text: "Production", type: "plain_text" },
                        value: "slq1:ask_b7fe13e099650f4f17a001ae5eecf8bf:1",
                      },
                    ],
                  },
                ]);

                await expect(
                  claimPendingAgentQuestionAnswerFromCaller({
                    sessionKey,
                    text: "Staging",
                    caller,
                    persist,
                    assertSourceCurrent: () => {},
                  }),
                ).resolves.toBe(true);
                await expect(
                  claimPendingAgentQuestionAnswerFromCaller({
                    sessionKey,
                    text: "Production",
                    caller,
                    persist,
                    assertSourceCurrent: () => {},
                  }),
                ).resolves.toBe(false);

                const resumed = await toolResult;
                expect(persist).toHaveBeenCalledOnce();
                expect(
                  slack.requests.filter((request) => request.url === "/api/chat.postMessage"),
                ).toHaveLength(1);
                expect(
                  slack.requests.filter((request) => request.url === "/api/chat.update"),
                ).toHaveLength(1);
                expect(gateway.manager.list()).toEqual([]);
                expect(resumed).toMatchObject({
                  details: {
                    status: "answered",
                    answers: { answers: { choice: ["Staging"] } },
                  },
                });
                expect(JSON.stringify(resumed)).toContain("Staging");
              } finally {
                runAbortController.abort();
                await Promise.allSettled(prepared.runCleanups.map((cleanup) => cleanup("test")));
              }
            },
          );
        } finally {
          admission.close();
        }
      });
    } finally {
      await slack.close();
    }
  });
});
