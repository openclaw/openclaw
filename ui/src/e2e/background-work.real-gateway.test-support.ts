import { createServer, type ServerResponse } from "node:http";
import type { Page } from "playwright";
import { expect } from "vitest";
import type {
  GatewayFrame,
  RequestFrame,
  ResponseFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const backgroundWorkFixture = {
  key: "agent:main:background-work",
  childLabel: "Review background work",
  childTask: "Inspect the background-work fixture and wait for the operator to stop this worker.",
  childText: "The fixture worker is inspecting background work.",
  output: "Background process ready: retained output from the loopback fixture.",
  processName: "Background proof process",
  draft: "Keep this unsent parent instruction through both panels and reload.",
  nextPrompt: "The stopped request is finished. Reply to this new instruction only.",
  nextReply: "This reply belongs to the new instruction.",
};

export function createBackgroundWorkInstance(port: number, notifyOnExit = false) {
  return createOpenClawTestInstance({
    name: "background-work",
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
    config: {
      update: { checkOnStart: false },
      gateway: { controlUi: { enabled: true } },
      cron: { enabled: false },
      tools: {
        profile: "full",
        codeMode: false,
        toolSearch: false,
        exec: { host: "gateway", mode: "full", notifyOnExit },
      },
      agents: {
        ownership: "explicit",
        defaults: {
          model: "background-fixture/parent",
          modelPolicy: { allow: ["background-fixture/*"] },
        },
        entries: { main: { identity: { name: "Background work fixture" } } },
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          "background-fixture": {
            api: "openai-responses",
            apiKey: "synthetic-background-fixture-key",
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
}

function toolEvents(name: string, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
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
        id: `response_${name}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function beginPendingResponse(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.flushHeaders();
}

/** Only the model provider is scripted. Gateway, exec, subagent, history and Stop are real. */
export async function startBackgroundWorkProvider(options: { ordinaryExec?: boolean } = {}) {
  const childStarted = createDeferred();
  const childClosed = createDeferred();
  const parentPending = createDeferred();
  const parentClosed = createDeferred();
  const processConnected = createDeferred();
  const processClosed = createDeferred();
  const failure = createDeferred<never>();
  void failure.promise.catch(() => {});
  const handlers = new Set<Promise<void>>();
  let parentRequests = 0;
  let childResponse: ServerResponse | undefined;
  let parentResponse: ServerResponse | undefined;
  let processResponse: ServerResponse | undefined;
  let port = 0;
  let stopped = false;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const handler = (async () => {
          if (request.method === "GET" && request.url === "/process") {
            expect(processResponse, "exec must create exactly one process").toBeUndefined();
            processResponse = response;
            response.once("close", () => processClosed.resolve());
            response.writeHead(200, { "content-type": "text/plain" });
            response.write(backgroundWorkFixture.output + "\n");
            processConnected.resolve();
            return; // The real exec process owns this open socket until Stop.
          }
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
            input?: Array<{ type?: string }>;
          } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (body.model === "child") {
            expect(childResponse, "fixture must not retry the held child").toBeUndefined();
            childResponse = response;
            response.once("close", () => childClosed.resolve());
            beginPendingResponse(response);
            childStarted.resolve();
            return;
          }
          expect(body.model).toBe("parent");
          const step = parentRequests++;
          if (step === 0) {
            expect(body.tools).toEqual(
              expect.arrayContaining([expect.objectContaining({ name: "exec" })]),
            );
            // No timer or daemon: a live HTTP response keeps Node alive; killing its process closes it.
            const script = `require("node:http").get("http://127.0.0.1:${port}/process",r=>r.pipe(process.stdout)).on("error",()=>process.exit(1))`;
            writeOpenAiResponsesSse(
              response,
              toolEvents("exec", {
                command: `node -e '${script}'`,
                title: backgroundWorkFixture.processName,
                ...(options.ordinaryExec ? { yieldMs: 10 } : { background: true }),
                timeoutSeconds: 0,
                host: "gateway",
              }),
            );
            return;
          }
          if (options.ordinaryExec && step >= 3) {
            expect(step, "a stopped request must not create an extra model turn").toBe(3);
            expect(JSON.stringify(body.input)).toContain(backgroundWorkFixture.nextPrompt);
            writeOpenAiResponsesText(response, {
              text: backgroundWorkFixture.nextReply,
              messageId: "new-instruction",
              responseId: "new-instruction-response",
            });
            return;
          }
          expect(body.input?.some((item) => item.type === "function_call_output")).toBe(true);
          if (step === 1) {
            expect(body.tools).toEqual(
              expect.arrayContaining([expect.objectContaining({ name: "sessions_spawn" })]),
            );
            writeOpenAiResponsesSse(
              response,
              toolEvents("sessions_spawn", {
                runtime: "subagent",
                mode: "run",
                thread: false,
                cleanup: "keep",
                label: backgroundWorkFixture.childLabel,
                task: backgroundWorkFixture.childTask,
                model: "background-fixture/child",
              }),
            );
            return;
          }
          expect(step, "parent must stay pending after spawning its worker").toBe(2);
          parentResponse = response;
          response.once("close", () => parentClosed.resolve());
          beginPendingResponse(response);
          parentPending.resolve();
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
  port = reserved.claim.port;
  return {
    port,
    wait: (gate: Promise<void>, signal: AbortSignal) =>
      withinTest(Promise.race([gate, failure.promise]), signal),
    childStarted: childStarted.promise,
    childClosed: childClosed.promise,
    parentPending: parentPending.promise,
    parentClosed: parentClosed.promise,
    processConnected: processConnected.promise,
    processClosed: processClosed.promise,
    processIsOpen: () => processResponse?.destroyed === false,
    parentIsPending: () => parentResponse?.destroyed === false,
    parentRequests: () => parentRequests,
    releaseProcess() {
      processResponse?.end();
    },
    writeChildProgress() {
      if (!childResponse || childResponse.destroyed) {
        throw new Error("Child provider is not pending");
      }
      const item = {
        type: "message",
        id: "child_progress",
        role: "assistant",
        status: "in_progress",
        content: [],
      };
      const events = [
        { type: "response.output_item.added", output_index: 0, item },
        {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: backgroundWorkFixture.childText,
        },
      ];
      for (const event of events) {
        childResponse.write(`data: ${JSON.stringify(event)}\n\n`);
      }
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

export type BackgroundWorkRpc = { request: RequestFrame; response: ResponseFrame };

/** Passive observation, not routing/interception. Authentication frames are never retained. */
export function observeBackgroundWorkRpc(page: Page, signal: AbortSignal) {
  const pending = new Map<string, RequestFrame>();
  const completed: BackgroundWorkRpc[] = [];
  const changed = new Set<() => void>();
  const methods = new Set([
    "chat.send",
    "chat.history",
    "sessions.list",
    "chat.abort",
    "sessions.abort",
    "sessions.processes.list",
    "sessions.processes.stop",
  ]);
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame: GatewayFrame = JSON.parse(String(payload));
      if (frame.type === "req" && methods.has(frame.method)) {
        pending.set(frame.id, frame);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame: GatewayFrame = JSON.parse(String(payload));
      if (frame.type !== "res") {
        return;
      }
      const request = pending.get(frame.id);
      if (!request) {
        return;
      }
      pending.delete(frame.id);
      completed.push({ request, response: frame });
      for (const notify of changed) {
        notify();
      }
    });
  });
  return {
    completed,
    async waitFor(matches: (rpc: BackgroundWorkRpc) => boolean, after = 0) {
      const found = createDeferred<BackgroundWorkRpc>();
      const check = () => {
        const rpc = completed.slice(after).find(matches);
        if (rpc) {
          found.resolve(rpc);
        }
      };
      changed.add(check);
      check();
      try {
        return await withinTest(found.promise, signal);
      } finally {
        changed.delete(check);
      }
    },
  };
}
