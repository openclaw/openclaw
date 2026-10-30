// Only inference is synthetic: chat.send, media materialization, history and rendering are real.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { setAvatar } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { renderBitmapTextPngBase64 } from "../../../test/helpers/live-image-probe.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ChatState } from "../pages/chat/chat-state-contract.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:managed-media-order";
const prompt = "Show the two prepared image cards in their numbered sections.";
const intro = "These two image cards belong to their own sections.";
const firstHeading = "1. Blue image card";
const secondHeading = "2. Orange image card";
const closing = "Both cards stay between their heading and the next paragraph.";
const viewport = { width: 1440, height: 1000 };
const expectedOrder = [
  intro,
  firstHeading,
  "image:232x104",
  secondHeading,
  "image:240x112",
  closing,
];
const fixtureKey = "synthetic-managed-media-key";

async function startProvider() {
  const echoReleased = createDeferred();
  const requests: string[] = [];
  const failures: string[] = [];
  const routes: string[] = [];
  let reply = "";
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        routes.push(`${request.method} ${request.url?.split("?")[0]}`);
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          request.resume();
          response.writeHead(404).end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("error", (error) => {
          failures.push(error.message);
          response.destroy();
        });
        request.on("end", () => {
          void (async () => {
            try {
              const model = asOptionalRecord(JSON.parse(body))?.model;
              if (model !== "echo" && model !== "metadata") {
                throw new Error("Unexpected fixture model");
              }
              requests.push(model);
              if (model === "echo" && (!reply || !body.includes(prompt))) {
                throw new Error("The provider must receive the browser chat.send prompt");
              }
              if (model === "echo") {
                await echoReleased.promise;
              }
              // Exactly one assistant message containing two local MEDIA directives.
              // No tool result, preordered image block, or direct transcript write bypasses delivery.
              writeOpenAiResponsesText(response, {
                text: model === "echo" ? reply : "Managed media ordering proof",
                messageId: `managed-media-message-${requests.length}`,
                responseId: `managed-media-response-${requests.length}`,
              });
            } catch (error) {
              failures.push(String(error));
              response.writeHead(500).end("Synthetic provider failed");
            }
          })();
        });
      }),
  });
  return {
    port: reservation.claim.port,
    requests,
    failures,
    routes,
    setReply(text: string) {
      reply = text;
    },
    releaseEcho: () => echoReleased.resolve(),
    close: () => {
      echoReleased.resolve();
      return runQaGatewayFixture(
        async () => {},
        async () => {
          const shutdown = reservation.releaseListener();
          reservation.listener.closeAllConnections();
          await shutdown;
        },
        reservation.claim.release,
      );
    },
  };
}

let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>> | undefined;
let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Managed image ordering through real chat.send and history",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    provider = await startProvider();
    const close = () =>
      runQaGatewayFixture(
        async () => {},
        () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "managed-media-order",
        entrypoint: ["dist/index.js"],
        env: {
          HOME: process.env.HOME,
          // Preserve external proxy routing while exempting this owned loopback fixture.
          NO_PROXY: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
          no_proxy: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
        },
        config: {
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          browser: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: "${OPENCLAW_WORKSPACE_DIR}",
              model: "media-order-fixture/echo",
              utilityModel: "media-order-fixture/metadata",
              models: {
                "media-order-fixture/echo": { params: { transport: "sse" } },
                "media-order-fixture/metadata": { params: { transport: "sse" } },
              },
              modelPolicy: { allow: ["media-order-fixture/*"] },
            },
            entries: { main: { identity: { name: "Image ordering proof" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "media-order-fixture": {
                api: "openai-responses",
                apiKey: fixtureKey,
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [
                  { id: "echo", name: "Image ordering" },
                  { id: "metadata", name: "Metadata" },
                ],
              },
            },
          },
          plugins: { allow: ["openai"] },
        },
      });
      instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
      const mediaDir = instance.state.statePath("media", "ordering-fixture");
      await mkdir(mediaDir, { recursive: true });
      const first = path.join(mediaDir, "blue-card.png");
      const second = path.join(mediaDir, "orange-card.png");
      for (const [filename, text, padding, background] of [
        [first, "A111", 24, { r: 70, g: 145, b: 225 }],
        [second, "B222", 28, { r: 240, g: 160, b: 65 }],
      ] as const) {
        await writeFile(
          filename,
          Buffer.from(renderBitmapTextPngBase64(text, { scale: 8, padding, background }), "base64"),
        );
      }
      provider.setReply(
        [
          intro,
          `## ${firstHeading}`,
          `MEDIA:${first}`,
          `## ${secondHeading}`,
          `MEDIA:${second}`,
          closing,
        ].join("\n\n"),
      );
      // Seed synthetic identity before the isolated Gateway takes database custody.
      const profile = ensureGatewayOwnerProfile("Image Proof", { env: instance.env });
      const avatar = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      expect(setAvatar(profile.id, avatar, "image/png", { env: instance.env }).ok).toBe(true);
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, close);
    }
  },
});

async function runCli(args: string[]) {
  const result = await instance.cli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function callGateway(method: string, params: Record<string, unknown>) {
  if (!client) {
    throw new Error("Gateway fixture client is not connected");
  }
  return asOptionalRecord(await client.request(method, params));
}

const writeEvidence = (name: string, value: unknown) =>
  writeFile(path.join(suite.artifactDir, name), JSON.stringify(value, null, 2) + "\n");
const privateFixtureValues = () => ({
  gatewayToken: instance.gatewayToken,
  hookToken: instance.hookToken,
  stateDir: instance.stateDir,
  homeDir: instance.homeDir,
  workingDirectory: process.cwd(),
  fixtureKey,
});

async function capture(page: Page, bubble: Locator, name: string) {
  const body = (await page.locator("body").textContent()) ?? "";
  for (const [field, value] of Object.entries(privateFixtureValues())) {
    expect(body.includes(value), `Capture must not expose ${field}`).toBe(false);
  }
  expect(new URL(page.url()).hash).toBe("");
  const content = [
    bubble.getByText(intro, { exact: true }),
    bubble.getByRole("heading", { name: firstHeading, exact: true }),
    bubble.getByRole("heading", { name: secondHeading, exact: true }),
    bubble.locator("img.chat-message-image").nth(0),
    bubble.locator("img.chat-message-image").nth(1),
    bubble.getByText(closing, { exact: true }),
  ];
  const frame = await takeControlUiScreenshotFrame(page, bubble, content, {
    animations: "disabled",
    scrollTo: bubble,
    elements: [bubble],
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  await writeFile(path.join(suite.artifactDir, `${name}-message.png`), frame.elements[0]!.png);
}

async function captureOrder(page: Page, bubble: Locator, phase: "live" | "reloaded") {
  await capture(page, bubble, phase === "live" ? "01-live" : "02-reloaded");
  return assertRenderedOrder(bubble);
}

async function renderedOrder(bubble: Locator) {
  return bubble
    .locator(".chat-text p, .chat-text h2, img.chat-message-image")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        if (element instanceof HTMLImageElement) {
          return [`image:${element.naturalWidth}x${element.naturalHeight}`];
        }
        // Markdown can wrap a media renderer in a paragraph; count that image only once.
        if (element.querySelector("img.chat-message-image")) {
          return [];
        }
        const text = element.textContent?.trim();
        return text ? [text] : [];
      }),
    );
}

async function assertRenderedOrder(bubble: Locator) {
  let order: string[] = [];
  await expect
    .poll(async () => {
      order = await renderedOrder(bubble);
      return order;
    })
    .toEqual(expectedOrder);
  return order;
}

async function recordImageDecodeFailure(bubble: Locator) {
  const images = await bubble.locator("img.chat-message-image").evaluateAll((elements) =>
    elements.map((image) => {
      if (!(image instanceof HTMLImageElement)) {
        throw new Error("Expected an image element");
      }
      return {
        protocol: new URL(image.src, document.baseURI).protocol,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        currentSrcMatchesSrc: image.currentSrc === image.src,
      };
    }),
  );
  const record = { schemaVersion: 1, kind: "managed-image-decode", images };
  console.error("[control-ui-e2e] image decode failure", JSON.stringify(record));
  const artifactDir = createControlUiE2eArtifactDir(
    "failure",
    process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim() ||
      path.resolve(".artifacts/control-ui-e2e-timeouts/local"),
  );
  await writeFile(
    path.join(artifactDir, "failure.public.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
}

async function runManagedMediaScenario() {
  await callGateway("sessions.create", {
    key: sessionKey,
    agentId: "main",
    label: "Managed image ordering",
    permissionMode: "full",
  });
  await suite.withPage(
    { locale: "en-US", serviceWorkers: "block", colorScheme: "dark", viewport },
    async ({ page }) => {
      const sends: string[] = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const frame = asOptionalRecord(JSON.parse(payload.toString()));
          if (frame?.method === "chat.send") {
            const params = asOptionalRecord(frame.params);
            if (params?.sessionKey === sessionKey && typeof params.message === "string") {
              sends.push(params.message);
            }
          }
        });
      });
      await page.addInitScript(() => {
        localStorage.setItem(
          "openclaw:control-ui:community-invite:v2",
          JSON.stringify({ dismissedAtMs: 1770000000000 }),
        );
      });
      await pairControlUiPage(page, runCli);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await waitForControlUiGatewayReady(page);
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill(prompt);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      // The recap belongs to a run the pane observed, not a terminal history row.
      await page.waitForFunction((expectedSessionKey) => {
        const pane = document.querySelector<HTMLElement & { state?: ChatState }>(
          'openclaw-chat-pane[aria-hidden="false"]',
        );
        const state = pane?.state;
        if (!pane || state?.sessionKey !== expectedSessionKey || !state.chatRunId) {
          return false;
        }
        // An existing indicator can precede projection of the acknowledged run.
        return Array.from(pane.querySelectorAll(".chat-working-indicator")).some((indicator) => {
          const runKey = indicator
            .closest('[data-chat-row-key^="agent-run:"]')
            ?.getAttribute("data-chat-row-key");
          const streamKey = indicator
            .closest('[data-chat-row-key^="stream-working:"]')
            ?.getAttribute("data-chat-row-key");
          return (
            indicator.checkVisibility({ visibilityProperty: true }) &&
            ((runKey && JSON.parse(runKey.slice("agent-run:".length))[0] === state.chatRunId) ||
              streamKey ===
                `stream-working:${JSON.stringify([expectedSessionKey, state.chatRunId])}`)
          );
        });
      }, sessionKey);
      provider.releaseEcho();
      const bubble = page.locator(".chat-group.assistant .chat-bubble").filter({ hasText: intro });
      const renderedImages = bubble.locator("img.chat-message-image");
      // A durable reply can briefly overlap its live tail until the run retires.
      await expect.poll(() => bubble.count()).toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "Stop generating", exact: true })
        .waitFor({ state: "detached" });
      await bubble.getByText(closing, { exact: true }).waitFor();
      const assertDecoded = async () => {
        // Run retirement starts a final history read that can replace live image nodes.
        await page.waitForFunction((expectedSessionKey) => {
          const state = document.querySelector<HTMLElement & { state?: ChatState }>(
            'openclaw-chat-pane[aria-hidden="false"]',
          )?.state;
          return (
            state?.sessionKey === expectedSessionKey &&
            state.chatRunId === null &&
            state.chatStream === null &&
            !state.chatLoading &&
            !state.chatError
          );
        }, sessionKey);
        await expect.poll(() => bubble.count()).toBe(1);
        await expect
          .poll(() => page.locator(".chat-group.assistant img.chat-message-image").count())
          .toBe(2);
        await expect.poll(() => renderedImages.count()).toBe(2);
        try {
          await renderedImages.evaluateAll(async (images) => {
            await Promise.all(
              images.map(async (image) => {
                if (!(image instanceof HTMLImageElement)) {
                  throw new Error("Expected an image element");
                }
                await image.decode();
              }),
            );
          });
        } catch (error) {
          await recordImageDecodeFailure(bubble).catch((captureError: unknown) => {
            console.error(
              "[control-ui-e2e] image decode diagnostics failed",
              captureError instanceof Error ? captureError.name : "UnknownError",
            );
          });
          throw error;
        }
        // History reconciliation can replace the nodes that just finished decoding.
        await expect
          .poll(() =>
            renderedImages.evaluateAll((images) =>
              images.map(
                (image) =>
                  image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
              ),
            ),
          )
          .toEqual([true, true]);
      };
      // Text can settle before managed media; wait for the real history projection.
      let history: Awaited<ReturnType<typeof callGateway>>;
      await expect
        .poll(async () => {
          history = await callGateway("chat.history", { sessionKey, limit: 20 });
          const messages = Array.isArray(history?.messages) ? history.messages : [];
          const assistant = messages
            .map(asOptionalRecord)
            .find((entry) => entry?.role === "assistant");
          const content = Array.isArray(assistant?.content) ? assistant.content : [];
          return content.filter((block) => asOptionalRecord(block)?.type === "image").length;
        })
        .toBe(2);
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const assistants = messages
        .map(asOptionalRecord)
        .filter((message) => message?.role === "assistant");
      expect(assistants).toHaveLength(1);
      const content = assistants[0]?.content;
      const blocks = Array.isArray(content) ? content.map(asOptionalRecord) : [];
      const persistedOrder = blocks.flatMap((block) => {
        if (block?.type === "image") {
          return ["image"];
        }
        if (block?.type !== "text" || typeof block.text !== "string") {
          return [];
        }
        const text = block.text;
        return [intro, firstHeading, secondHeading, closing]
          .filter((label) => text.includes(label))
          .toSorted((left, right) => text.indexOf(left) - text.indexOf(right));
      });
      expect(persistedOrder).toEqual([
        intro,
        firstHeading,
        "image",
        secondHeading,
        "image",
        closing,
      ]);
      const images = blocks.filter((block) => block?.type === "image");
      expect(images).toHaveLength(2);
      const artifactIds = images.map((image) => image?.artifactId);
      for (const id of artifactIds) {
        expect(id).toMatch(/^artifact_managed_image_/u);
      }
      expect(new Set(artifactIds).size).toBe(2);
      expect(JSON.stringify(assistants)).not.toContain("MEDIA:");
      expect(JSON.stringify(assistants)).not.toContain(instance.stateDir);

      const assistantId = readSessionMessageIdentity(assistants[0])?.id ?? null;
      const sessionId = asOptionalRecord(history?.sessionInfo)?.sessionId ?? history?.sessionId;
      const cursor = history?.deltaCursor;
      expect(assistantId).toBeTypeOf("string");
      expect(sessionId).toBeTypeOf("string");
      expect(cursor).toBeTypeOf("string");
      // Live previews may decode before history adopts their canonical sources.
      await expect
        .poll(async () => {
          const adopted = await page
            .locator(".chat-pane-cache__pane--active")
            .evaluate((element, expectedAssistantId) => {
              const state = (element as HTMLElement & { state: ChatPageHost }).state;
              const message = state.chatMessages.find((value) => {
                if (!value || typeof value !== "object" || !("__openclaw" in value)) {
                  return false;
                }
                const identity = value["__openclaw"];
                return (
                  identity &&
                  typeof identity === "object" &&
                  "id" in identity &&
                  identity.id === expectedAssistantId
                );
              });
              return {
                sessionKey: state.sessionKey,
                sessionId: state.currentSessionId,
                loading: state.chatLoading,
                cursor: state.chatHistoryCursor,
                message,
                rendered: Array.from(
                  element.querySelectorAll(".chat-group.assistant .chat-bubble"),
                ).some(
                  (renderedBubble) =>
                    renderedBubble.getAttribute("data-entry-id") === expectedAssistantId,
                ),
              };
            }, assistantId);
          const adoptedContent = asOptionalRecord(adopted.message)?.content;
          return {
            ...adopted,
            images: Array.isArray(adoptedContent)
              ? adoptedContent.map(asOptionalRecord).filter((block) => block?.type === "image")
              : [],
          };
        })
        .toEqual(
          expect.objectContaining({
            sessionKey,
            sessionId,
            loading: false,
            rendered: true,
            cursor: expect.objectContaining({ cursor, sessionId }),
            images,
          }),
        );
      // Sidebar rows omit full policy fields. Wait for the pane's own list
      // read and rendered managed images, not equality with a full CLI row.
      await expect
        .poll(() =>
          page.locator(".chat-pane-cache__pane--active").evaluate((element) => {
            const state = (element as HTMLElement & { state: ChatPageHost }).state;
            const selected = state.sessionsResult?.sessions.find(
              (row) => row.key === state.sessionKey,
            );
            return {
              sessionId: selected?.sessionId,
              loading: state.sessionsLoading,
              error: state.sessionsError,
            };
          }),
        )
        .toEqual({ sessionId, loading: false, error: null });
      // Stream retirement can precede the durable history receipt. Capture
      // managed images after that handoff, then retain strict node identity.
      await expect
        .poll(() => bubble.locator(".chat-image-frame--managed img.chat-message-image").count())
        .toBe(2);
      await assertDecoded();
      // The terminal session recap arrives independently of final text and image decode.
      // It adds height beside the bubble, so admit it before freezing live ancestry.
      try {
        await page
          .locator(".chat-group.assistant")
          .filter({ hasText: intro })
          .locator(".chat-turn-recap")
          .waitFor({ state: "visible" });
      } catch (error) {
        await withTimeout(
          page.evaluate(
            ({ expectedSessionKey, assistantRunId }) => {
              const pane = document.querySelector<HTMLElement & { state?: ChatPageHost }>(
                'openclaw-chat-pane[aria-hidden="false"]',
              );
              const state = pane?.state;
              const row = state?.sessionsResult?.sessions.find(
                (entry) => entry.key === expectedSessionKey,
              );
              const recaps = Array.from(pane?.querySelectorAll(".chat-turn-recap") ?? []);
              return {
                recapPanePresent: Boolean(pane),
                recapSessionMatches: state?.sessionKey === expectedSessionKey,
                recapRunCleared: state?.chatRunId === null,
                recapWorkingIndicatorCount:
                  pane?.querySelectorAll(".chat-working-indicator").length ?? null,
                recapPendingSendCount:
                  state?.chatQueue.filter(
                    (item) => item.sendState === "submitting" || item.sendState === "sending",
                  ).length ?? null,
                recapPendingSendMatchesAssistant:
                  state?.chatQueue.some((item) => item.sendRunId === assistantRunId) ?? null,
                recapCount: recaps.length,
                recapVisibleCount: recaps.filter((element) =>
                  element.checkVisibility({ visibilityProperty: true }),
                ).length,
                recapAttachedCount: recaps.filter((element) =>
                  element.closest(".chat-group.assistant"),
                ).length,
                recapTerminalRowPresent: Boolean(row),
                recapTerminalRowDone: row?.status === "done",
                recapTerminalRuntimeMs:
                  typeof row?.runtimeMs === "number" && Number.isFinite(row.runtimeMs)
                    ? row.runtimeMs
                    : null,
                recapAssistantRunPresent: assistantRunId !== null,
                recapTerminalRunMatchesAssistant:
                  assistantRunId !== null && row?.lastRunId === assistantRunId,
              };
            },
            {
              expectedSessionKey: sessionKey,
              assistantRunId: readSessionMessageIdentity(assistants[0])?.runId ?? null,
            },
          ),
          1_000,
        )
          .then((facts) => recordControlUiE2eFailureFacts(page, facts))
          .catch(() => undefined);
        throw error;
      }
      const liveOrder = await captureOrder(page, bubble, "live");
      expect(await bubble.textContent()).not.toContain("MEDIA:");
      expect(sends).toEqual([prompt]);
      expect(provider.requests.filter((model) => model === "echo")).toHaveLength(1);
      expect(provider.failures).toEqual([]);

      await page.reload();
      await waitForControlUiGatewayReady(page);
      await bubble.getByText(closing, { exact: true }).waitFor();
      await assertDecoded();
      const reloadedOrder = await captureOrder(page, bubble, "reloaded");
      expect(await page.locator(".chat-group.assistant .chat-bubble").count()).toBe(1);
      expect(sends).toEqual([prompt]);
      expect(provider.requests.filter((model) => model === "echo")).toHaveLength(1);
      await writeEvidence("proof.json", {
        gateway: "isolated real Gateway serving the built Control UI",
        inference: "synthetic loopback OpenAI Responses endpoint",
        liveOrder,
        persistedOrder,
        reloadedOrder,
        assistantMessages: assistants.length,
        managedImages: artifactIds.length,
        chatSends: sends.length,
        primaryProviderRequests: provider.requests.filter((model) => model === "echo").length,
      });
    },
  );
}

suite.define(() => {
  it("keeps headings, managed images and trailing prose ordered live and after reload without duplicates", async (test) => {
    try {
      await suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: runManagedMediaScenario,
      });
    } catch (error) {
      let gatewayLog = instance.logs();
      for (const value of Object.values(privateFixtureValues())) {
        gatewayLog = gatewayLog.replaceAll(value, "<fixture>");
      }
      await writeEvidence("failure.json", {
        providerRequests: provider.requests,
        providerFailures: provider.failures,
        providerRoutes: provider.routes,
        gatewayLog,
      });
      throw error;
    }
  }, 180_000);
});
