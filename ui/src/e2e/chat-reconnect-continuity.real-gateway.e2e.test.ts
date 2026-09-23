import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:reconnect-continuity";
const firstPrompt = "Stream through a browser reconnect.";
const opening = "The first streamed section is visible. ";
const offlineTail = "The second section arrived while the browser was offline.";
const followUpPrompt = "Confirm the next turn is clean.";
const followUpReply = "The follow-up completed exactly once.";

type Frame = {
  type?: string;
  id?: string;
  ok?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  payload?: {
    inFlightRun?: { runId?: string; text?: string } | null;
  };
};

let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;

const suite = createControlUiE2eSuite({
  name: "Control UI real Gateway reconnect continuity",
  startServerBeforeBrowser: true,
  async startServer() {
    provider = await startScrollInferenceFixture();
    const close = async () => {
      await runQaGatewayFixture(
        async () => {},
        async () => instance?.cleanup(),
        () => provider.close(),
      );
    };
    try {
      instance = await createOpenClawTestInstance({
        name: "control-ui-reconnect-continuity",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "reconnect-fixture/echo",
              modelPolicy: { allow: ["reconnect-fixture/*"] },
            },
            entries: { main: { identity: { name: "Reconnect fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "reconnect-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-fixture-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                models: [{ id: "echo", name: "Reconnect fixture" }],
              },
            },
          },
          plugins: { allow: [] },
        },
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

suite.define(() => {
  it("reconstructs one streamed turn after browser socket loss, then aborts and follows up cleanly", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const create = await instance.cli([
          "gateway",
          "call",
          "sessions.create",
          "--json",
          "--params",
          JSON.stringify({ key: sessionKey, agentId: "main", label: "Reconnect continuity" }),
        ]);
        expect(create.code, create.stderr).toBe(0);
        const readInFlightRun = async () => {
          const history = await instance.cli([
            "gateway",
            "call",
            "chat.history",
            "--json",
            "--params",
            JSON.stringify({ sessionKey }),
          ]);
          expect(history.code, history.stderr).toBe(0);
          return (JSON.parse(history.stdout) as Frame["payload"]).inFlightRun;
        };
        const url = new URL(suite.server.baseUrl);
        url.pathname = "/chat/main/reconnect-continuity";
        url.hash = new URLSearchParams({ token: instance.gatewayToken }).toString();

        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
          async ({ page }) => {
            await page.addInitScript(() => {
              localStorage.setItem(
                "openclaw:control-ui:community-invite",
                JSON.stringify({ dismissedAtMs: 1770000000000 }),
              );
            });
            const sent: Array<{ connection: number; frame: Frame }> = [];
            const received: Array<{ connection: number; frame: Frame }> = [];
            const reconnectGate = createDeferred();
            let connections = 0;
            let dropConnection: (() => void) | undefined;

            const websocketOrigin = new URL(suite.server.baseUrl);
            websocketOrigin.protocol = "ws:";
            await page.routeWebSocket(`${websocketOrigin.origin}/**`, async (socket) => {
              connections += 1;
              const connection = connections;
              if (connection > 1) {
                await reconnectGate.promise;
              }
              const server = socket.connectToServer();
              socket.onMessage((message) => {
                sent.push({ connection, frame: JSON.parse(message.toString()) as Frame });
                server.send(message);
              });
              server.onMessage((message) => {
                received.push({ connection, frame: JSON.parse(message.toString()) as Frame });
                socket.send(message);
              });
              dropConnection = () => {
                void socket.close({ code: 1012, reason: "fixture browser link loss" });
              };
            });

            await page.goto(url.href);
            await waitForControlUiGatewayReady(page);
            const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
            const firstTurn = provider.plan();
            await composer.fill(firstPrompt);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect
              .poll(() => sent.find(({ frame }) => frame.method === "chat.send")?.frame.id)
              .toEqual(expect.any(String));
            const firstSend = sent.find(({ frame }) => frame.method === "chat.send")?.frame;
            await expect
              .poll(
                () =>
                  received.find(
                    ({ connection, frame }) => connection === 1 && frame.id === firstSend?.id,
                  )?.frame,
              )
              .toMatchObject({ type: "res", ok: true });
            await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(1);
            await firstTurn.append(opening);
            await page
              .locator(".chat-group.assistant")
              .getByText(opening.trim(), { exact: true })
              .waitFor();

            const firstRunId = firstSend?.params?.idempotencyKey;
            expect(typeof firstRunId).toBe("string");
            expect(connections).toBe(1);
            expect(dropConnection).toBeDefined();
            dropConnection?.();
            await expect
              .poll(() =>
                page.evaluate(() => {
                  const app = document.querySelector<
                    HTMLElement & {
                      runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } };
                    }
                  >("openclaw-app");
                  return app?.runtime?.context?.gateway?.snapshot?.phase;
                }),
              )
              .toBe("reconnecting");

            await firstTurn.append(offlineTail);
            await expect
              .poll(readInFlightRun, { timeout: 15_000 })
              .toMatchObject({ runId: firstRunId, text: opening + offlineTail });
            reconnectGate.resolve();
            await expect.poll(() => connections).toBe(2);
            await waitForControlUiGatewayReady(page);

            const reconstructed = page.locator(".chat-group.assistant", {
              hasText: opening.trim(),
            });
            await expect
              .poll(async () => (await reconstructed.textContent()) ?? "")
              .toContain(offlineTail);
            expect(await reconstructed.count()).toBe(1);
            const reconstructedText = (await reconstructed.textContent()) ?? "";
            expect(occurrences(reconstructedText, opening.trim())).toBe(1);
            expect(occurrences(reconstructedText, offlineTail)).toBe(1);
            const assistantTranscript = (
              await page.locator(".chat-group.assistant").allTextContents()
            ).join("\n");
            expect(occurrences(assistantTranscript, offlineTail)).toBe(1);
            expect(await page.locator(".chat-group.user", { hasText: firstPrompt }).count()).toBe(
              1,
            );

            const reconnectHistoryRequest = sent.find(
              ({ connection, frame }) =>
                connection === 2 &&
                frame.type === "req" &&
                ["chat.startup", "chat.history"].includes(frame.method ?? "") &&
                frame.params?.sessionKey === sessionKey,
            )?.frame;
            expect(reconnectHistoryRequest?.id).toEqual(expect.any(String));
            const reconnectHistory = received.find(
              ({ connection, frame }) =>
                connection === 2 &&
                frame.type === "res" &&
                frame.id === reconnectHistoryRequest?.id,
            )?.frame.payload;
            expect(reconnectHistory?.inFlightRun).toMatchObject({
              runId: firstRunId,
              text: opening + offlineTail,
            });

            const stop = page.getByRole("button", { name: "Stop generating", exact: true });
            await stop.waitFor({ state: "visible" });
            await stop.click();
            await expect
              .poll(
                () =>
                  sent.filter(
                    ({ frame }) =>
                      frame.method === "chat.abort" &&
                      frame.params?.sessionKey === sessionKey &&
                      frame.params?.runId === firstRunId,
                  ).length,
              )
              .toBe(1);
            await stop.waitFor({ state: "detached" });

            const followUpTurn = provider.plan();
            await composer.fill(followUpPrompt);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect.poll(() => provider.requests(), { timeout: 15_000 }).toBe(2);
            await followUpTurn.append(followUpReply);
            await followUpTurn.finish();
            await page
              .locator(".chat-group.assistant")
              .getByText(followUpReply, { exact: true })
              .waitFor();
            await stop.waitFor({ state: "detached" });

            await page.reload();
            await waitForControlUiGatewayReady(page);
            await page
              .locator(".chat-group.assistant")
              .getByText(followUpReply, { exact: true })
              .waitFor();
            expect(await page.locator(".chat-group.user", { hasText: firstPrompt }).count()).toBe(
              1,
            );
            expect(
              await page.locator(".chat-group.user", { hasText: followUpPrompt }).count(),
            ).toBe(1);
            const reloadedPartial = page.locator(".chat-group.assistant", {
              hasText: opening.trim(),
            });
            expect(await reloadedPartial.count()).toBe(1);
            const reloadedPartialText = (await reloadedPartial.textContent()) ?? "";
            expect(occurrences(reloadedPartialText, opening.trim())).toBe(1);
            expect(occurrences(reloadedPartialText, offlineTail)).toBe(1);
            const reloadedGroups = await page.locator(".chat-group").evaluateAll((groups) =>
              groups.map((group) => ({
                assistant: group.classList.contains("assistant"),
                user: group.classList.contains("user"),
                text: group.textContent ?? "",
              })),
            );
            const firstAssistantIndex = reloadedGroups.findIndex(
              (group) => group.assistant && group.text.includes(opening.trim()),
            );
            const followUpUserIndex = reloadedGroups.findIndex(
              (group) => group.user && group.text.includes(followUpPrompt),
            );
            const followUpAssistantIndex = reloadedGroups.findIndex(
              (group) => group.assistant && group.text.includes(followUpReply),
            );
            expect(firstAssistantIndex).toBeGreaterThanOrEqual(0);
            expect(followUpUserIndex).toBeGreaterThan(firstAssistantIndex);
            expect(followUpAssistantIndex).toBeGreaterThan(followUpUserIndex);
            expect(reloadedGroups[followUpAssistantIndex]?.text).not.toContain(offlineTail);
            const reloadedAssistantTranscript = reloadedGroups
              .filter((group) => group.assistant)
              .map((group) => group.text)
              .join("\n");
            expect(occurrences(reloadedAssistantTranscript, offlineTail)).toBe(1);
            expect(occurrences(reloadedAssistantTranscript, followUpReply)).toBe(1);
            expect(provider.requests()).toBe(2);
            expect(provider.failures).toEqual([]);
          },
        );
      },
    });
  }, 120_000);
});
