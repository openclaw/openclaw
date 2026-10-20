import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const automationFixture = {
  key: "agent:main:dashboard:automation-real-proof",
  name: "Watch museum CI and review comments",
  prompt:
    "Inspect the synthetic museum CI watch. Rearm this same job while waiting; finish silently when no further check is needed.",
  question: "Summarize the completed museum CI watch.",
  answer:
    "The museum checks passed. The watch completed after three checks; no further action is needed.",
  delayMs: 15_000,
};

export async function createAutomationInstance(port: number, artifactDir: string) {
  const profile =
    "automation-proof-" + path.basename(artifactDir).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const instance = await createOpenClawTestInstance({
    name: "automation-real-proof",
    // Both Gateway and CLI use the canonical launcher and the same disposable profile.
    entrypoint: ["--silent", "openclaw", "--profile", profile],
    gatewayCommandPrefix: ["pnpm"],
    state: { prefix: path.join(path.relative(os.tmpdir(), artifactDir), "state-") },
    env: {
      OPENCLAW_PROFILE: profile,
      // Synthetic provider traffic stays on loopback; external proxy policy is unchanged.
      NO_PROXY: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
        .filter(Boolean)
        .join(","),
      no_proxy: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
        .filter(Boolean)
        .join(","),
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CRON: undefined,
      VITEST: undefined,
    },
    config: {
      update: { checkOnStart: false },
      gateway: { controlUi: { enabled: true } },
      logging: { file: path.join(artifactDir, "runtime.log") },
      cron: { enabled: true },
      tools: { profile: "full", codeMode: false, toolSearch: false },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace: "${OPENCLAW_WORKSPACE_DIR}",
          heartbeat: { every: "0m" },
          model: "automation-fixture/watcher",
          modelPolicy: { allow: ["automation-fixture/*"] },
        },
        entries: { main: { identity: { name: "Museum watch fixture" } } },
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          "automation-fixture": {
            api: "openai-responses",
            apiKey: "synthetic-automation-fixture-key",
            baseUrl: "http://127.0.0.1:" + port + "/v1",
            models: [{ id: "watcher", name: "Synthetic watcher" }],
          },
        },
      },
      plugins: { allow: [] },
    },
  });
  instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
  return instance;
}

function nextCheckEvents(index: number) {
  const item = {
    type: "function_call",
    id: "fc_automation_" + index,
    call_id: "call_automation_" + index,
    name: "automations",
    arguments: JSON.stringify({ action: "next_check", in: automationFixture.delayMs + "ms" }),
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response_automation_" + index,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

/** Only inference is synthetic: the scheduler, agent, tool execution and transcript are real. */
export async function startAutomationProvider() {
  const thirdStarted = createDeferred();
  const failure = createDeferred<never>();
  void failure.promise.catch(() => {});
  const handlers = new Set<Promise<void>>();
  const toolResults: unknown[] = [];
  let requests = 0;
  let third: ServerResponse | undefined;
  let stopped = false;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const handler = (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body: {
            model: string;
            tools?: Array<{ name?: string }>;
            input?: Array<{ type?: string; output?: string }>;
          } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          expect(body.model).toBe("watcher");
          const index = requests++;
          if (index === 0 || index === 2) {
            expect(body.tools).toEqual(
              expect.arrayContaining([expect.objectContaining({ name: "automations" })]),
            );
            writeOpenAiResponsesSse(response, nextCheckEvents(index));
          } else if (index === 1 || index === 3) {
            const output = body.input?.findLast(
              (item) => item.type === "function_call_output",
            )?.output;
            expect(output).toBeTruthy();
            const result: unknown = JSON.parse(output!);
            expect(result).toMatchObject({ ok: true, delayMs: automationFixture.delayMs });
            toolResults.push(result);
            writeOpenAiResponsesText(response, {
              text: "NO_REPLY",
              messageId: "silent-" + index,
              responseId: "silent-response-" + index,
            });
          } else if (index === 4) {
            third = response;
            thirdStarted.resolve();
            // Hold genuine inference so the browser can inspect the scheduler's running state.
          } else {
            expect(index, "one human follow-up and no unexpected agent retries").toBe(5);
            expect(JSON.stringify(body.input)).toContain(automationFixture.question);
            writeOpenAiResponsesText(response, {
              text: automationFixture.answer,
              messageId: "useful-final",
              responseId: "useful-final-response",
            });
          }
        })();
        handlers.add(handler);
        void handler.then(
          () => handlers.delete(handler),
          (error: unknown) => {
            handlers.delete(handler);
            failure.reject(error);
            response.destroy();
          },
        );
      }),
  });
  return {
    port: reserved.claim.port,
    requests: () => requests,
    toolResults,
    waitForThird: (signal: AbortSignal) =>
      withinTest(Promise.race([thirdStarted.promise, failure.promise]), signal),
    finishThird() {
      if (!third || third.destroyed) {
        throw new Error("Third scheduler turn is not waiting");
      }
      writeOpenAiResponsesText(third, {
        text: "NO_REPLY",
        messageId: "silent-third",
        responseId: "silent-third-response",
      });
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await runQaGatewayFixture(
        async () => {
          reserved.listener.closeAllConnections();
          await reserved.releaseListener();
          await Promise.all(handlers);
        },
        () => reserved.claim.release(),
      );
    },
  };
}
