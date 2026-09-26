// Exercise the production lifecycle and WebSocket; only the model provider is deterministic.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { finished } from "node:stream/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const preference = "ui.notifications.otherSessionsFinished";
const existingPreference = "notifications.web.v1";
const existingValue = {
  categories: { agentFinished: true, agentQuestion: true },
  detailLevel: "private",
};
const sessionKey = "agent:main:independent-proof";
const replyText = "The isolated development task is complete.";
let artifactDir: string;
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startProvider>>;
const proof: Record<string, unknown> = {
  provider: "deterministic loopback Responses fixture",
  gateway: "production child process",
  injectedGatewayEvents: false,
};

async function startProvider() {
  let requests = 0;
  let held = false;
  let pending: ServerResponse | undefined;
  const respond = (response: ServerResponse) =>
    writeOpenAiResponsesText(response, {
      text: replyText,
      messageId: `proof-message-${requests}`,
      responseId: `proof-response-${requests}`,
    });
  const release = () => {
    held = false;
    if (pending) {
      respond(pending);
      pending = undefined;
    }
  };
  const server = createServer((request, response) => {
    void finished(request.resume())
      .then(() => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        requests += 1;
        if (held) {
          pending = response;
        } else {
          respond(response);
        }
      })
      .catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind a TCP port");
  }
  return {
    port: address.port,
    requests: () => requests,
    hold: () => {
      held = true;
    },
    release,
    async stop() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function call<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    async ({ requestMethod, requestParams }) => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime: { context: { gateway: { snapshot: { client: GatewayBrowserClient | null } } } };
      };
      const client = app.runtime.context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Gateway client missing");
      }
      return client.request(requestMethod, requestParams);
    },
    { requestMethod: method, requestParams: params },
  ) as Promise<T>;
}

async function flushRendering(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

const suite = createControlUiE2eSuite({
  name: "Unattended completion notices through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("real-gateway-completion");
    provider = await startProvider();
    try {
      instance = await createOpenClawTestInstance({
        name: "completion-notices-proof",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "completion-fixture/echo",
              modelPolicy: { allow: ["completion-fixture/*"] },
            },
            entries: { main: { identity: { name: "Development proof" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "completion-fixture": {
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
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        async close() {
          try {
            await instance.cleanup();
          } finally {
            await provider.stop();
            proof.providerRequests = provider.requests();
            await fs.writeFile(
              path.join(artifactDir, "proof.json"),
              JSON.stringify(proof, null, 2) + "\n",
            );
          }
        },
      };
    } catch (error) {
      try {
        await instance?.cleanup();
      } finally {
        await provider.stop();
      }
      throw error;
    }
  },
});

suite.define(() => {
  it("persists opt-in without changing push preferences and announces real independent/later runs with exact navigation and visible-session suppression", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const handoff = await instance.cli(["dashboard", "--json"]);
        expect(handoff.code, handoff.stderr + handoff.stdout).toBe(0);
        const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
        const url = new URL(browserUrl);
        url.pathname = "/settings/notifications";
        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
          async ({ page }) => {
            const completions: Array<{ sessionKey: string; runId: string; status: string }> = [];
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("websocket", (socket) =>
              socket.on("framereceived", ({ payload }) => {
                const frame = JSON.parse(payload.toString());
                if (frame.type === "event" && frame.event === "session.run.completed") {
                  completions.push(frame.payload);
                }
              }),
            );
            await page.addInitScript(() => {
              localStorage.setItem(
                "openclaw:control-ui:community-invite",
                JSON.stringify({ dismissedAtMs: 1770000000000 }),
              );
            });
            await page.goto(url.href);
            await waitForControlUiGatewayReady(page);
            const row = page
              .locator(".settings-row--toggle")
              .filter({ hasText: "Notify when other sessions finish" });
            const toggle = row.locator("wa-switch");
            await row.waitFor();
            await expect
              .poll(() =>
                toggle.evaluate(
                  (element) => (element as HTMLElement & { disabled: boolean }).disabled,
                ),
              )
              .toBe(false);
            await call(page, "users.prefs.set", {
              entries: { [existingPreference]: existingValue },
            });
            await call(page, "sessions.create", {
              key: sessionKey,
              agentId: "main",
              label: "Independent development task",
            });
            const run = async () => {
              const started = await call<{ runId: string; status: string }>(page, "chat.send", {
                sessionKey,
                message: "Complete this isolated development task.",
                deliver: false,
                idempotencyKey: randomUUID(),
              });
              expect(started.status).toBe("started");
              const settled = await call<{ status: string }>(page, "agent.wait", {
                runId: started.runId,
                timeoutMs: 30000,
              });
              expect(settled.status).toBe("ok");
              await expect
                .poll(() => completions.find((event) => event.runId === started.runId))
                .toMatchObject({ sessionKey, status: "ok" });
              return started.runId;
            };
            proof.defaultOffRun = await run();
            await flushRendering(page);
            expect(await page.locator(".app-toast").count()).toBe(0);
            await page.screenshot({ path: path.join(artifactDir, "01-before-opt-in.png") });
            await row.locator(".settings-row__title").click();
            await expect
              .poll(() =>
                toggle.evaluate(
                  (element) => (element as HTMLElement & { checked: boolean }).checked,
                ),
              )
              .toBe(true);
            const preferences = await call<{ status: string; entries: Record<string, unknown> }>(
              page,
              "users.prefs.get",
              { keys: [preference, existingPreference] },
            );
            expect(preferences.entries).toMatchObject({
              [preference]: true,
              [existingPreference]: existingValue,
            });
            proof.existingPushPreferencePreserved = true;
            // Reload verifies persisted preference and no historical completion replay.
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await expect
              .poll(() =>
                toggle.evaluate(
                  (element) => (element as HTMLElement & { checked: boolean }).checked,
                ),
              )
              .toBe(true);
            expect(await page.locator(".app-toast").count()).toBe(0);
            proof.enabledRun = await run();
            const toast = page.locator(".app-toast");
            await toast.filter({ hasText: "Independent development task" }).waitFor();
            expect(
              await toggle.evaluate((element) => {
                const control = element as HTMLElement & { checked: boolean; disabled: boolean };
                return { checked: control.checked, disabled: control.disabled };
              }),
            ).toEqual({ checked: true, disabled: false });
            await page.screenshot({ path: path.join(artifactDir, "02-real-completion-toast.png") });
            await toast.getByRole("button", { name: "Open session" }).click();
            await page.getByRole("textbox", { name: "Chat composer" }).waitFor();
            await expect
              .poll(() =>
                page.evaluate(() => {
                  const pane = document.querySelector(
                    'openclaw-chat-pane[aria-hidden="false"]',
                  ) as HTMLElement & { state: { sessionKey: string } };
                  return pane?.state?.sessionKey;
                }),
              )
              .toBe(sessionKey);
            await page
              .locator(".chat-bubble")
              .getByText(replyText, { exact: true })
              .last()
              .waitFor();
            await page.screenshot({ path: path.join(artifactDir, "03-exact-session-opened.png") });
            proof.exactSessionNavigation = true;
            proof.visibleRun = await run();
            await flushRendering(page);
            expect(await toast.count()).toBe(0);
            proof.visibleSessionSuppressed = true;
            proof.gatewayCompletionCount = completions.length;
            expect(completions).toHaveLength(3);
            expect(provider.requests()).toBe(3);
            expect(errors).toEqual([]);
            proof.browserErrors = errors;
            await proveBackgroundReconnect(page);
            expect(errors).toEqual([]);
          },
        );
      },
    });
  }, 240000);
});

async function proveBackgroundReconnect(page: Page) {
  let disconnect: (() => Promise<void>) | undefined;
  let sockets = 0;
  await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
    const server = socket.connectToServer();
    sockets += 1;
    disconnect = async () => {
      await socket.close({ code: 1012, reason: "isolated transport recovery proof" });
      await server.close();
    };
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "openclaw:control-ui:community-invite",
      JSON.stringify({ dismissedAtMs: 1770000000000 }),
    );
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await waitForControlUiGatewayReady(page);
  await call(page, "users.prefs.set", { entries: { [preference]: false } });
  await page.waitForFunction(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime: {
        context: {
          inAppNotifications: { snapshot: { enabled: boolean; loading: boolean } };
        };
      };
    };
    return (
      !app.runtime.context.inAppNotifications.snapshot.enabled &&
      !app.runtime.context.inAppNotifications.snapshot.loading
    );
  });
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime: { context: { gateway: ApplicationGateway } };
    };
    const gateway = app.runtime.context.gateway;
    const originalClient = gateway.snapshot.client;
    const originalHello = gateway.snapshot.hello;
    const originalProfile = gateway.snapshot.selfUser?.id;
    const observed = {
      clearedIdentityDuringReconnect: false,
      sameClient: false,
      sameProfile: false,
      freshHello: false,
      recovered: false,
    };
    Object.assign(window, { completionReconnectProof: observed });
    const unsubscribe = gateway.subscribe((state) => {
      if (state.phase === "reconnecting" && state.hello === null && state.selfUser === null) {
        observed.clearedIdentityDuringReconnect = true;
      }
      if (observed.clearedIdentityDuringReconnect && state.phase === "connected") {
        observed.sameClient = state.client === originalClient;
        observed.sameProfile = state.selfUser?.id === originalProfile;
        observed.freshHello = state.hello !== originalHello;
        observed.recovered = true;
        unsubscribe();
      }
    });
  });
  const previousRequests = provider.requests();
  provider.hold();
  try {
    const composer = page.locator(".new-session-page__message");
    await composer.fill("Complete the reconnect proof background task.");
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Start session", exact: true })
          .getAttribute("aria-disabled"),
      )
      .toBe("false");
    await composer.press("Control+Enter");
    await expect.poll(() => provider.requests()).toBe(previousRequests + 1);
    await expect.poll(() => composer.inputValue()).toBe("");
    await page.screenshot({
      path: path.join(artifactDir, "04-background-before-reconnect.png"),
    });
    if (!disconnect) {
      throw new Error("No production WebSocket to disconnect");
    }
    await disconnect();
    await expect.poll(() => sockets).toBe(2);
    await page.waitForFunction(
      () =>
        (window as typeof window & { completionReconnectProof: { recovered: boolean } })
          .completionReconnectProof.recovered,
    );
    const recovery = await page.evaluate(
      () =>
        (window as typeof window & { completionReconnectProof: Record<string, boolean> })
          .completionReconnectProof,
    );
    expect(recovery).toEqual({
      clearedIdentityDuringReconnect: true,
      sameClient: true,
      sameProfile: true,
      freshHello: true,
      recovered: true,
    });
    provider.release();
    const toast = page.locator(".app-toast");
    await toast.filter({ hasText: "Done" }).waitFor();
    await page.screenshot({
      path: path.join(artifactDir, "05-background-after-reconnect-completion.png"),
    });
    const preferences = await call<{ entries: Record<string, unknown> }>(page, "users.prefs.get", {
      keys: [preference, existingPreference],
    });
    expect(preferences.entries).toMatchObject({
      [preference]: false,
      [existingPreference]: existingValue,
    });
    proof.backgroundReconnect = {
      ...recovery,
      generalPreferenceDisabled: true,
      actionableToast: true,
      browserSockets: sockets,
    };
    await toast.getByRole("button", { name: "Open session" }).click();
    await page.locator(".chat-bubble").getByText(replyText, { exact: true }).waitFor();
  } finally {
    provider.release();
  }
}
