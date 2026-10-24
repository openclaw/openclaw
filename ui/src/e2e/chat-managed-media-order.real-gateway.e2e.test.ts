// Only inference is synthetic: chat.send, media materialization, history and rendering are real.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
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
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pollCount } from "./new-session-page.test-support.ts";

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
  let reply = "";
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
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
let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Managed image ordering through real chat.send and history",
  startServerBeforeBrowser: true,
  async startServer() {
    provider = await startProvider();
    const close = () =>
      runQaGatewayFixture(
        async () => {},
        () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      const noProxy = [
        process.env.no_proxy ?? process.env.NO_PROXY,
        "127.0.0.1",
        "localhost",
        "::1",
      ]
        .filter(Boolean)
        .join(",");
      instance = await createOpenClawTestInstance({
        name: "managed-media-order",
        entrypoint: ["dist/index.js"],
        env: {
          HOME: process.env.HOME,
          // Preserve external proxy routing while exempting this owned loopback fixture.
          NO_PROXY: noProxy,
          no_proxy: noProxy,
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
  return asOptionalRecord(
    JSON.parse(
      await runCli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]),
    ),
  );
}

const privateFixtureValues = () => ({
  gatewayToken: instance.gatewayToken,
  hookToken: instance.hookToken,
  stateDir: instance.stateDir,
  homeDir: instance.homeDir,
  workingDirectory: process.cwd(),
  fixtureKey,
});

async function assertRenderedOrder(page: Page, bubble: Locator) {
  const body = (await page.locator("body").textContent()) ?? "";
  for (const [field, value] of Object.entries(privateFixtureValues())) {
    expect(body.includes(value), `Rendered page must not expose ${field}`).toBe(false);
  }
  expect(new URL(page.url()).hash).toBe("");
  await expect.poll(() => renderedOrder(bubble)).toEqual(expectedOrder);
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
      await expect.poll(() => provider.requests.filter((model) => model === "echo").length).toBe(1);
      provider.releaseEcho();
      const bubble = page.locator(".chat-group.assistant .chat-bubble").filter({ hasText: intro });
      const renderedImages = bubble.locator("img.chat-message-image");
      // A durable reply can briefly overlap its live tail until the run retires.
      await pollCount(bubble).toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "Stop generating", exact: true })
        .waitFor({ state: "detached" });
      await bubble.getByText(closing, { exact: true }).waitFor();
      const assertDecoded = async () => {
        await pollCount(bubble).toBe(1);
        await pollCount(page.locator(".chat-group.assistant img.chat-message-image")).toBe(2);
        await pollCount(renderedImages).toBe(2);
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
      // Read persisted history through its real owner, never pre-seed ordered content.
      const history = await callGateway("chat.history", { sessionKey, limit: 20 });
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
      expect(persistedOrder).toEqual(
        expectedOrder.map((entry) => (entry.startsWith("image:") ? "image" : entry)),
      );
      const images = blocks.filter((block) => block?.type === "image");
      expect(images).toHaveLength(2);
      const artifactIds = images.map((image) => image?.artifactId);
      for (const id of artifactIds) {
        expect(id).toMatch(/^artifact_managed_image_/u);
      }
      expect(new Set(artifactIds).size).toBe(2);
      expect(JSON.stringify(assistants)).not.toContain("MEDIA:");
      expect(JSON.stringify(assistants)).not.toContain(instance.stateDir);

      // Wait for durable managed images, not transient stream previews.
      await pollCount(bubble.locator(".chat-image-frame--managed img.chat-message-image")).toBe(2);
      await assertDecoded();
      await assertRenderedOrder(page, bubble);
      expect(await bubble.textContent()).not.toContain("MEDIA:");
      expect(sends).toEqual([prompt]);
      expect(provider.requests.filter((model) => model === "echo")).toHaveLength(1);
      expect(provider.failures).toEqual([]);

      await page.reload();
      await waitForControlUiGatewayReady(page);
      await bubble.getByText(closing, { exact: true }).waitFor();
      await assertDecoded();
      await assertRenderedOrder(page, bubble);
      expect(await page.locator(".chat-group.assistant .chat-bubble").count()).toBe(1);
      expect(sends).toEqual([prompt]);
      expect(provider.requests.filter((model) => model === "echo")).toHaveLength(1);
    },
  );
}

suite.define(() => {
  it(
    "keeps headings, managed images and trailing prose ordered live and after reload without duplicates",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: runManagedMediaScenario,
      }),
    180_000,
  );
});
