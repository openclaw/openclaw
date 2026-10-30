import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesSse } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  createBackgroundWorkInstance,
  observeBackgroundWorkRpc,
} from "./background-work.real-gateway.test-support.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { callGateway } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:stop-long-turn";
const prompt = "Walk through every fixture step, then wait for my instruction.";
// Two transcript rows per step put the opening prompt outside the 80-row history tail.
const toolSteps = 48;

function execCall(step: number) {
  const item = {
    type: "function_call",
    id: `fc_step_${step}`,
    call_id: `call_step_${step}`,
    name: "exec",
    arguments: JSON.stringify({ command: `echo fixture-step-${step}`, host: "gateway" }),
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
        id: `response_step_${step}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

/** Only the model is scripted: each step runs a real exec, then the last request stays pending. */
async function startLongTurnProvider() {
  const pending = createDeferred();
  const failure = createDeferred<never>();
  void failure.promise.catch(() => {});
  const held = new Set<ServerResponse>();
  let requests = 0;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          // The script depends only on request order.
          request.resume();
          await once(request, "end");
          const step = requests++;
          if (step < toolSteps) {
            writeOpenAiResponsesSse(response, execCall(step));
            return;
          }
          held.add(response);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.flushHeaders();
          pending.resolve();
        })().catch((error: unknown) => {
          failure.reject(error);
          response.destroy();
        });
      }),
  });
  return {
    port: reserved.claim.port,
    wait: (signal: AbortSignal) =>
      withinTest(Promise.race([pending.promise, failure.promise]), signal),
    async stop() {
      await runQaGatewayFixture(
        async () => {
          reserved.listener.closeAllConnections();
          await reserved.releaseListener();
        },
        () => reserved.claim.release(),
      );
    },
  };
}

let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startLongTurnProvider>>;
const suite = createControlUiE2eSuite({
  name: "Composer Stop keeps a long turn's opening prompt through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    await fs.access("dist/control-ui/index.html");
    provider = await startLongTurnProvider();
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => provider.stop(),
      );
    try {
      instance = await createBackgroundWorkInstance(provider.port);
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

suite.define(() => {
  it(
    "keeps the opening prompt visible after stopping a turn longer than the history tail",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: (signal) =>
          suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
            const wire = observeBackgroundWorkRpc(page, signal);
            await callGateway(instance, "sessions.create", {
              key: sessionKey,
              agentId: "main",
              label: "Long stopped turn",
            });
            await pairFixture(page, instance);
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            await waitForControlUiGatewayReady(page);
            const { pane, composer, send, stop } = chatControls(page);
            await composer.waitFor();
            await assertServedUi(page, suite.server.baseUrl);
            await composer.fill(prompt);
            await send.click();
            await provider.wait(signal);
            const opening = pane.getByText(prompt, { exact: true });
            await opening.waitFor();

            // Any earlier-history boundary after Stop means the pane dropped rows it held.
            await page.evaluate(() => {
              const seen = { boundary: false };
              Object.assign(window, { stopLongTurnHistory: seen });
              new MutationObserver(() => {
                seen.boundary ||= document.querySelector(".chat-history-boundary") !== null;
              }).observe(document.body, { childList: true, subtree: true });
            });
            const beforeStop = wire.completed.length;
            await stop.click();
            const stopped = await wire.waitFor(
              (rpc) => rpc.request.method === "chat.abort",
              beforeStop,
            );
            expect(stopped.response.ok).toBe(true);
            await stop.waitFor({ state: "hidden" });
            // Stop resets the delta cursor; the full tail no longer reaches the prompt.
            const tail = await wire.waitFor(
              (rpc) =>
                rpc.request.method === "chat.history" &&
                (rpc.response.payload as { hasMore?: boolean } | undefined)?.hasMore === true,
              beforeStop,
            );
            expect(JSON.stringify(tail.response.payload)).not.toContain(prompt);
            // One older read fills the gap to the start this pane already showed.
            await wire.waitFor(
              (rpc) =>
                rpc.request.method === "chat.history" &&
                JSON.stringify(rpc.response.payload).includes(prompt),
              beforeStop,
            );
            await page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
            );

            await opening.waitFor();
            // The filled gap merges once; the prompt never renders twice.
            expect(await opening.count()).toBe(1);
            expect(
              await page.evaluate(
                () =>
                  (window as unknown as { stopLongTurnHistory: { boundary: boolean } })
                    .stopLongTurnHistory.boundary,
              ),
              "rows this pane already showed must not become earlier history",
            ).toBe(false);
          }),
      }),
    180000,
  );
});
