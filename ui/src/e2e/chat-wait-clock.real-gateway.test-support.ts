import { createServer, type ServerResponse } from "node:http";
import { expect } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const waitClockFixture = {
  key: "agent:main:dashboard:wait-clock-proof",
  label: "Wait clock proof",
  childLabel: "Check the release notes",
  childTask: "Check the synthetic release notes and report when the review is complete.",
  initialPrompt: "Start a separate review session, then wait for its result.",
  acknowledgment: "The review is running in a separate session. I will return with the result.",
  updatePrompt: "Give me a brief update while the review continues.",
  updateReply: "The review is still running. I will report its result when it finishes.",
  childReply: "The release notes review is complete. No issues found.",
  resumedReply: "The review finished successfully. No issues found in the release notes.",
};

export async function createWaitClockInstance(port: number, controlUiRoot: string) {
  const instance = await createOpenClawTestInstance({
    name: "wait-clock",
    // Admission below requires built artifacts; never let the helper rebuild during proof.
    entrypoint: ["dist/index.js"],
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
    config: {
      update: { checkOnStart: false },
      gateway: { controlUi: { enabled: true, root: controlUiRoot } },
      cron: { enabled: false },
      tools: { profile: "full", codeMode: false, toolSearch: false },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace: "${OPENCLAW_WORKSPACE_DIR}",
          model: "wait-fixture/parent",
          modelPolicy: { allow: ["wait-fixture/*"] },
        },
        entries: { main: { identity: { name: "Review assistant" } } },
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          "wait-fixture": {
            api: "openai-responses",
            apiKey: "synthetic-wait-fixture-key",
            baseUrl: "http://127.0.0.1:" + port + "/v1",
            models: [
              { id: "parent", name: "Fixture parent" },
              { id: "child", name: "Fixture child" },
            ],
          },
        },
      },
      plugins: { allow: [] },
    },
  });
  instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
  return instance;
}

type ProviderInput = { type?: string; name?: string; call_id?: string; output?: string };
function toolResult(input: ProviderInput[] | undefined, toolName: string) {
  // Responses replay normalizes tool-call IDs; match the actual emitted call, not our wire ID.
  const call = input?.findLast((item) => item.type === "function_call" && item.name === toolName);
  expect(call?.call_id, "the real transcript must retain the tool call").toBeTruthy();
  const output = input?.findLast(
    (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
  )?.output;
  expect(typeof output, "the real runtime must deliver this tool result").toBe("string");
  const result: {
    status?: string;
    childSessionKey?: string;
    runId?: string;
    pendingChildren?: unknown[];
  } = JSON.parse(output!);
  return result;
}

function writeTool(
  response: ServerResponse,
  name: string,
  callId: string,
  args: Record<string, unknown>,
) {
  const item = {
    type: "function_call",
    id: "fc_" + callId,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
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
        id: callId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

/** Model transport only: the Gateway executes all tools and owns the native child registry. */
export async function startWaitClockProvider() {
  const childStarted = createDeferred();
  const failure = createDeferred<never>();
  void failure.promise.catch(() => {});
  const handlers = new Set<Promise<void>>();
  const requests: Array<{ method?: string; url?: string }> = [];
  const receipts: Array<{ step: number; tool: string; result: ReturnType<typeof toolResult> }> = [];
  let parentRequests = 0;
  let childResponse: ServerResponse | undefined;
  let childReleased = false;
  let stopped = false;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
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
          const body: { model: string; tools?: Array<{ name?: string }>; input?: ProviderInput[] } =
            JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (body.model === "child") {
            expect(childResponse, "the child must not retry while held").toBeUndefined();
            childResponse = response;
            childStarted.resolve();
            return; // Release only after both real-browser waiting captures.
          }
          expect(body.model).toBe("parent");
          const step = parentRequests++;
          if (step === 0) {
            expect(body.tools).toEqual(
              expect.arrayContaining([expect.objectContaining({ name: "sessions_spawn" })]),
            );
            writeTool(response, "sessions_spawn", "launch_review", {
              runtime: "subagent",
              visible: true,
              agentId: "main",
              context: "isolated",
              label: waitClockFixture.childLabel,
              taskName: "review-notes",
              task: waitClockFixture.childTask,
              model: "wait-fixture/child",
            });
          } else if (step === 1) {
            const result = toolResult(body.input, "sessions_spawn");
            receipts.push({ step, tool: "sessions_spawn", result });
            expect(result.status).toBe("accepted");
            expect(result.childSessionKey).toMatch(/^agent:main:dashboard:/);
            writeTool(response, "sessions_yield", "initial_yield", {
              acknowledgment: waitClockFixture.acknowledgment,
            });
          } else if (step === 2) {
            expect(JSON.stringify(body.input)).toContain(waitClockFixture.updatePrompt);
            expect(childReleased).toBe(false);
            writeTool(response, "sessions_yield", "update_yield", {});
          } else if (step === 3) {
            const result = toolResult(body.input, "sessions_yield");
            receipts.push({ step, tool: "sessions_yield", result });
            // Never manufacture already_pending: this must come from the real registry/tool owner.
            expect(result.status).toBe("already_pending");
            expect(result.pendingChildren).toHaveLength(1);
            writeOpenAiResponsesText(response, {
              text: waitClockFixture.updateReply,
              messageId: "update_reply",
              responseId: "update_response",
            });
          } else {
            expect(step, "exactly one completion turn must resume the parent").toBe(4);
            expect(childReleased).toBe(true);
            expect(JSON.stringify(body.input)).toContain(waitClockFixture.childReply);
            writeOpenAiResponsesText(response, {
              text: waitClockFixture.resumedReply,
              messageId: "resumed_reply",
              responseId: "resumed_response",
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
    receipts,
    requests,
    waitForChild: (signal: AbortSignal) =>
      withinTest(Promise.race([childStarted.promise, failure.promise]), signal),
    check: () => Promise.race([failure.promise, Promise.resolve()]),
    parentRequests: () => parentRequests,
    childIsRunning: () => childResponse?.destroyed === false && !childReleased,
    releaseChild() {
      if (!childResponse || childResponse.destroyed || childReleased) {
        throw new Error("The actual child provider request is not pending");
      }
      childReleased = true;
      writeOpenAiResponsesText(childResponse, {
        text: waitClockFixture.childReply,
        messageId: "child_reply",
        responseId: "child_response",
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
