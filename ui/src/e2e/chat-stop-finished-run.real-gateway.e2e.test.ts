// Real Gateway proof for a Stop that targets a run the Gateway already finished:
// the browser lost every lifecycle notification, so the composer must recover
// from the Gateway's "nothing to abort" answer instead of staying inert.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import type { SessionsListResult } from "../api/types.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:stop-finished";
const replyText = "Finished reply from the fixture provider.";
// Long enough for the browser's post-send refreshes to observe an active run,
// so only lifecycle notifications could settle it afterwards.
const providerDelayMs = 6_000;
const suite = createControlUiE2eSuite({
  name: "Chat Stop after a real Gateway finished the run",
});

type Frame = {
  type?: string;
  method?: string;
  id?: unknown;
  event?: string;
  payload?: Record<string, unknown>;
};

async function startFixtureProvider() {
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      // Drain the request body before answering.
      await new Promise<void>((resolve) => {
        request.on("end", resolve);
        request.resume();
      });
      if (request.method === "POST" && request.url === "/v1/responses") {
        requests += 1;
        await new Promise((resolve) => {
          setTimeout(resolve, providerDelayMs);
        });
        writeOpenAiResponsesText(response, {
          text: replyText,
          messageId: `msg-${requests}`,
          responseId: `resp-${requests}`,
        });
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    requests: () => requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

suite.define(() => {
  it("restores the composer after Stop targets a run the Gateway already finished", async () => {
    const provider = await startFixtureProvider();
    let instance: OpenClawTestInstance | undefined;
    const record: Record<string, unknown> = {};
    const sent: Frame[] = [];
    const received: Frame[] = [];
    const dropped: Array<{ event?: string; state?: unknown }> = [];
    const passedEvents: Array<{ event?: string; state?: unknown }> = [];
    try {
      instance = await createOpenClawTestInstance({
        name: "stop-finished-run",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
          },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "stop-fixture/echo",
              modelPolicy: { allow: ["stop-fixture/*"] },
            },
            entries: { main: { identity: { name: "Stop fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "stop-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-unused-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                models: [{ id: "echo", name: "Echo" }],
              },
            },
          },
          plugins: { allow: [] },
        },
      });
      await instance.startGateway();
      const gateway = instance;
      const call = async (method: string, params: Record<string, unknown>) => {
        const result = await gateway.cli([
          "gateway",
          "call",
          method,
          "--json",
          "--params",
          JSON.stringify(params),
        ]);
        expect(result.code, result.stderr).toBe(0);
        return result.stdout;
      };
      const sessionRow = async () => {
        const list: SessionsListResult = JSON.parse(
          await call("sessions.list", { agentId: "main", limit: 50 }),
        );
        const row = list.sessions.find((entry) => entry.key === sessionKey);
        return row
          ? {
              hasActiveRun: row.hasActiveRun ?? null,
              status: row.status ?? null,
              lastRunId: row.lastRunId ?? null,
            }
          : null;
      };
      await call("sessions.create", {
        key: sessionKey,
        agentId: "main",
        label: "Stop finished run",
      });

      let runStarted = false;
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.routeWebSocket(`ws://127.0.0.1:${gateway.port}/**`, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const frame = JSON.parse(message.toString()) as Frame;
              if (frame.type === "req") {
                sent.push(frame);
                if (frame.method === "chat.send") {
                  runStarted = true;
                }
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = JSON.parse(message.toString()) as Frame;
              if (frame.type === "event" && runStarted) {
                // The browser still sees stream deltas, presence, ticks, and RPC
                // replies, but loses the run's lifecycle notifications: terminal
                // chat state, session row changes, agent lifecycle, message events.
                const lifecycleEvent =
                  (frame.event === "chat" && frame.payload?.state !== "delta") ||
                  frame.event === "sessions.changed" ||
                  frame.event === "agent" ||
                  frame.event === "session.message";
                if (lifecycleEvent) {
                  dropped.push({ event: frame.event, state: frame.payload?.state });
                  // Keep the event sequence contiguous so the client does not
                  // resync by reconnecting; only the notification itself is lost.
                  socket.send(JSON.stringify({ ...frame, event: "tick", payload: {} }));
                  return;
                }
              }
              if (frame.type === "res") {
                received.push(frame);
              } else if (frame.type === "event" && runStarted) {
                passedEvents.push({ event: frame.event, state: frame.payload?.state });
              }
              socket.send(message);
            });
          });
          const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${gateway.port}`);
          // Keep the host's own session catalogs out of the captures.
          url.searchParams.set("nav", "collapsed");
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to 127.0.0.1:${gateway.port}`, exact: true })
            .click();
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.waitFor({ state: "visible", timeout: 30_000 });
          await composer.fill("finish this run without telling the browser");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const stop = page.getByRole("button", { name: "Stop generating" });
          await stop.waitFor({ state: "visible" });
          await expect.poll(sessionRow, { timeout: 10_000 }).toMatchObject({ hasActiveRun: true });
          record.gatewayRowDuringRun = await sessionRow();

          // The real Gateway finishes the run while the browser never learns it.
          await expect.poll(sessionRow, { timeout: 30_000 }).toMatchObject({ hasActiveRun: false });
          record.gatewayRowAfterRun = await sessionRow();
          record.providerRequests = provider.requests();
          // One connection for the whole scenario: no resync hid the lost events.
          expect(sent.filter((frame) => frame.method === "connect")).toHaveLength(1);
          await page.waitForTimeout(1_000);
          await stop.waitFor({ state: "visible" });
          await page.screenshot({
            path: path.join(suite.artifactDir, "01-stop-after-gateway-finished.png"),
          });

          await stop.click();
          await expect
            .poll(() => sent.some((frame) => frame.method === "chat.abort"), { timeout: 10_000 })
            .toBe(true);
          const abort = sent.find((frame) => frame.method === "chat.abort");
          await expect
            .poll(() => received.find((frame) => frame.id === abort?.id), { timeout: 10_000 })
            .toBeDefined();
          const abortResponse = received.find((frame) => frame.id === abort?.id);
          record.abortRequest = abort;
          record.abortResponse = abortResponse;
          // The real Gateway had nothing left to abort.
          expect(abortResponse?.payload).toMatchObject({ ok: true, aborted: false });
          await page.waitForTimeout(1_000);
          await page.screenshot({
            path: path.join(suite.artifactDir, "02-after-stop-click.png"),
          });

          await stop.waitFor({ state: "detached", timeout: 10_000 });
          await page.getByText(replyText).first().waitFor({ timeout: 10_000 });
          await composer.fill("next message");
          await page
            .getByRole("button", { name: "Send message", exact: true })
            .waitFor({ state: "visible" });
          await page.screenshot({ path: path.join(suite.artifactDir, "03-composer-restored.png") });
          expect(sent.filter((frame) => frame.method === "chat.abort")).toHaveLength(1);
        },
      );
    } finally {
      const sendIndex = sent.findIndex((frame) => frame.method === "chat.send");
      record.browserRequests = sent.map((frame) => frame.method);
      record.connectRequests = sent.filter((frame) => frame.method === "connect").length;
      record.browserRequestsAfterSend =
        sendIndex >= 0 ? sent.slice(sendIndex).map((frame) => frame.method) : [];
      record.responses = received.map((frame) => {
        const payload = frame.payload as
          | { status?: unknown; sessionInfo?: Record<string, unknown>; sessions?: unknown }
          | undefined;
        return {
          id: frame.id,
          method: sent.find((request) => request.id === frame.id)?.method ?? null,
          status: payload?.status ?? null,
          sessionInfo: payload?.sessionInfo
            ? { hasActiveRun: payload.sessionInfo.hasActiveRun, status: payload.sessionInfo.status }
            : undefined,
          sessionRows: Array.isArray(payload?.sessions)
            ? (payload.sessions as Array<Record<string, unknown>>)
                .filter((row) => row.key === sessionKey)
                .map((row) => ({ hasActiveRun: row.hasActiveRun, status: row.status }))
            : undefined,
        };
      });
      record.droppedEvents = dropped;
      record.passedEvents = passedEvents;
      try {
        await fs.writeFile(
          path.join(suite.artifactDir, "proof.json"),
          `${JSON.stringify(record, null, 2)}\n`,
        );
      } finally {
        // Artifact failures must never leave the Gateway child or the fixture
        // provider running.
        try {
          await instance?.cleanup();
        } finally {
          await provider.stop();
        }
      }
    }
  }, 240_000);
});
