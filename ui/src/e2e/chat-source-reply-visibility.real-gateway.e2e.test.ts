import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayFrame } from "../../../packages/gateway-protocol/src/schema/frames.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { extractTextCached } from "../lib/chat/message-extract.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { startProofRecording } from "../test-helpers/proof-video.ts";
import { observeBackgroundWorkRpc } from "./background-work.real-gateway.test-support.ts";
import { chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  sourceReplyFixture as fixture,
  startSourceReplyProvider,
} from "./chat-source-reply-visibility.real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiRoot = path.resolve("dist/control-ui");
function defineSourceReplyScenario(final: false | undefined) {
  const continuing = final === false;
  const scenario = continuing ? "nonterminal-final-false" : "terminal-final-omitted";
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startSourceReplyProvider>>;
  let client: Awaited<ReturnType<typeof connectChatGateway>>;
  let artifactDir: string;
  const proof: Record<string, unknown> = {
    boundary: "real isolated Gateway, real message tool, storage/history and Chromium",
    inference: "scripted loopback Responses transport; no external-provider or Talk call",
    injectedHistory: false,
    websocketInterception: false,
    scenario,
    expectedModelRequests: continuing ? 2 : 1,
    complete: false,
  };
  const saveProof = () =>
    fs.writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
  const suite = createControlUiE2eSuite({
    name: "Real Gateway explicit source reply: " + scenario,
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
      artifactDir = createControlUiE2eArtifactDir("source-reply-" + scenario);
      provider = await startSourceReplyProvider(final);
      const close = () =>
        runQaGatewayFixture(
          () => instance?.cleanup(),
          () => provider.close(),
          async () => {
            proof.gatewayStopped = !instance?.child;
            await saveProof();
          },
        );
      try {
        instance = await createChatGatewayInstance({
          name: "source-reply-product-proof",
          provider: "reply-fixture",
          identity: "Checklist assistant",
          model: "scripted",
          apiKey: "synthetic-source-reply-key",
          baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
          models: [{ id: "scripted", name: "Local scripted inference" }],
          defaults: { workspace: "${OPENCLAW_WORKSPACE_DIR}" },
          entrypoint: ["dist/index.js"],
          config: {
            update: { checkOnStart: false },
            gateway: { controlUi: { enabled: true, root: uiRoot } },
            tools: { profile: "full", codeMode: false, toolSearch: false },
          },
        });
        instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("synthetic-workspace");
        expect(instance.stateDir).not.toBe(
          process.env.OPENCLAW_SOURCE_REPLY_HOST_STATE ?? path.join(os.homedir(), ".openclaw"),
        );
        expect(instance.port).not.toBe(
          Number(process.env.OPENCLAW_SOURCE_REPLY_HOST_PORT ?? "18789"),
        );
        expect(instance.configPath.startsWith(instance.homeDir + path.sep)).toBe(true);
        await instance.startGateway();
        expect(instance.child?.pid).toBeGreaterThan(0);
        expect(instance.child?.pid).not.toBe(process.pid);
        if (process.env.OPENCLAW_SOURCE_REPLY_HOST_PID) {
          const hostPid = Number(process.env.OPENCLAW_SOURCE_REPLY_HOST_PID);
          expect(
            Number.isSafeInteger(hostPid) && hostPid > 0,
            "capture requires the verified hosting Gateway PID",
          ).toBe(true);
          expect(instance.child?.pid).not.toBe(hostPid);
        }
        proof.notHostingGateway = true;
        proof.runtimeEntrypointSha256 = createHash("sha256")
          .update(await fs.readFile("dist/index.js"))
          .digest("hex");
        proof.sourceHead = process.env.OPENCLAW_SOURCE_REPLY_PROOF_HEAD ?? "unrecorded";
        await saveProof();
        return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
      } catch (error) {
        return runQaGatewayFixture(async (): Promise<never> => {
          throw error;
        }, close);
      }
    },
  });
  function deliveredRow(history: ChatHistoryResult) {
    const rows = (history.messages ?? []).filter(
      (message) => extractTextCached(message)?.trim() === fixture.delivered,
    );
    expect(rows).toHaveLength(1);
    const message = record(rows[0])!;
    const meta = record(message["__openclaw"]);
    return {
      id: meta?.id,
      runId: meta?.runId,
      idempotencyKey: message.idempotencyKey ?? meta?.idempotencyKey,
      marker: record(message.openclawDeliveryMirror) ?? null,
    };
  }
  async function screenshot(page: Page, name: string) {
    if (!capture) {
      return;
    }
    const text = (await page.locator("body").textContent()) ?? "";
    for (const secret of [
      instance.gatewayToken,
      instance.hookToken,
      instance.homeDir,
      instance.stateDir,
      "synthetic-source-reply-key",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(new URL(page.url()).hash).toBe("");
    const png = await takeControlUiViewportScreenshot(page, page.locator("body"), [
      page.locator(".chat-work-group button").first(),
    ]);
    await fs.writeFile(path.join(artifactDir, name + ".png"), png);
  }
  suite.define(() => {
    it(
      continuing
        ? "keeps a nonterminal delivered reply visible after backing acknowledgment and reload"
        : "retains an omitted-final source marker and receipt after natural completion and reload",
      async (test) => {
        await suite.runScenario(test, {
          retainedState: () => instance.stateDir,
          run: async (signal) => {
            const options = {
              viewport: { width: 1280, height: 900 },
              colorScheme: "light" as const,
              locale: "en-US",
              serviceWorkers: "block" as const,
            };
            const recording = capture
              ? await startProofRecording(suite.browser, {
                  dir: artifactDir,
                  deviceScaleFactor: 1,
                  viewport: options.viewport,
                  contextOptions: options,
                })
              : undefined;
            const context = recording?.context ?? (await suite.newBrowserContext(options));
            const page = recording?.page ?? (await context.newPage());
            const wire = observeBackgroundWorkRpc(page, signal);
            const published: Array<{ id: unknown; idempotencyKey: unknown }> = [];
            page.on("websocket", (socket) =>
              socket.on("framereceived", ({ payload }) => {
                const frame: GatewayFrame = JSON.parse(String(payload));
                if (frame.type !== "event" || frame.event !== "session.message") {
                  return;
                }
                const event = record(frame.payload);
                const message = record(event?.message);
                if (
                  event?.sessionKey === fixture.key &&
                  extractTextCached(message)?.trim() === fixture.delivered
                ) {
                  published.push({ id: event.messageId, idempotencyKey: message?.idempotencyKey });
                }
              }),
            );
            try {
              proof.stage = "pair isolated browser";
              recording?.caption("Real isolated Gateway; only inference is scripted locally.");
              await page.addInitScript(() =>
                localStorage.setItem(
                  "openclaw:control-ui:community-invite:v2",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                ),
              );
              await client.request("sessions.create", {
                key: fixture.key,
                agentId: "main",
                label: "Source reply product proof",
              });
              await pairFixture(page, instance);
              await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
              await waitForControlUiGatewayReady(page);
              const script = await page
                .locator('script[type="module"][src]')
                .first()
                .getAttribute("src");
              const bytes = await context.request
                .get(new URL(script!, suite.server.baseUrl).href)
                .then((response) => response.body());
              expect(bytes.equals(await fs.readFile(path.join(uiRoot, script!.slice(1))))).toBe(
                true,
              );
              proof.uiAssetSha256 = createHash("sha256").update(bytes).digest("hex");
              const { pane, composer, send, stop } = chatControls(page);
              await composer.waitFor();
              recording?.caption(
                continuing
                  ? "Real chat request: message.send sets final:false and allows continuation."
                  : "Real chat request: message.send omits finality and naturally ends the turn.",
              );
              await composer.fill(fixture.prompt);
              proof.stage = "real UI chat request and message tool execution";
              await send.click();
              const sent = await wire.waitFor((rpc) => rpc.request.method === "chat.send");
              expect(sent.response.ok).toBe(true);
              const transcript = pane.locator(".chat-text");
              const delivered = transcript.getByText(fixture.delivered, { exact: true });
              const acknowledgment = transcript.getByText(fixture.acknowledgment, { exact: true });
              await delivered.waitFor();
              await expect.poll(provider.requests).toBe(continuing ? 2 : 1);
              expect(provider.failures).toEqual([]);
              await expect.poll(() => published.length).toBe(1);
              if (continuing) {
                await stop.waitFor();
                expect(provider.receivedToolResult()).toBe(true);
                recording?.caption(
                  "The nonterminal reply was really published; backing inference is waiting.",
                );
                if (capture) {
                  await page.waitForTimeout(1500);
                }
                proof.active = {
                  deliveredVisible: true,
                  sourcePublications: published.length,
                  toolResultObserved: provider.receivedToolResult(),
                };
                proof.stage = "backing acknowledgment and completion";
                provider.finish();
                await stop.waitFor({ state: "hidden" });
                await acknowledgment.waitFor();
              } else {
                proof.stage = "natural terminal completion";
                await stop.waitFor({ state: "hidden" });
              }
              const work = pane.locator(".chat-work-group button").first();
              await work.waitFor();
              expect(await work.getAttribute("aria-expanded")).toBe("false");
              expect(await transcript.getByText(fixture.commentary, { exact: true }).count()).toBe(
                0,
              );
              const history = await client.request<ChatHistoryResult>("chat.history", {
                sessionKey: fixture.key,
                limit: 50,
              });
              expect(
                (history.messages ?? []).filter(
                  (message) => extractTextCached(message)?.trim() === fixture.acknowledgment,
                ),
              ).toHaveLength(continuing ? 1 : 0);
              const receipt = deliveredRow(history);
              expect(receipt.id).toBeTruthy();
              expect(receipt.idempotencyKey).toBeTruthy();
              expect(published[0]).toEqual({
                id: receipt.id,
                idempotencyKey: receipt.idempotencyKey,
              });
              const visibleAfterCompletion = await delivered.isVisible();
              proof.completed = {
                receipt,
                deliveredVisible: visibleAfterCompletion,
                closedWork: true,
                publicationCount: published.length,
              };
              recording?.caption(
                "The run completed. Work is closed; check whether the delivered reply remains.",
              );
              await screenshot(page, "completed");
              if (capture) {
                await page.waitForTimeout(1500);
              }
              recording?.caption("Reload the browser and read the same actual stored history.");
              proof.stage = "browser reload and stored history";
              await page.reload();
              await waitForControlUiGatewayReady(page);
              await transcript
                .getByText(continuing ? fixture.acknowledgment : fixture.prompt, { exact: true })
                .waitFor();
              await work.waitFor();
              const reloaded = deliveredRow(
                await client.request<ChatHistoryResult>("chat.history", {
                  sessionKey: fixture.key,
                  limit: 50,
                }),
              );
              expect(reloaded).toEqual(receipt);
              const visibleAfterReload = await delivered.isVisible();
              proof.reloaded = {
                receipt: reloaded,
                deliveredVisible: visibleAfterReload,
                closedWork: (await work.getAttribute("aria-expanded")) === "false",
              };
              await screenshot(page, "reloaded");
              if (capture) {
                await page.waitForTimeout(2000);
              }
              const settledDeliveredVisible = await delivered.isVisible();
              const settledAcknowledgmentVisible = await acknowledgment.isVisible();
              proof.settledReload = {
                deliveredVisible: settledDeliveredVisible,
                acknowledgmentVisible: settledAcknowledgmentVisible,
                transcriptText: await transcript.allTextContents(),
              };
              if (!visibleAfterReload) {
                recording?.caption(
                  "The unchanged stored reply is inside the collapsed work disclosure.",
                );
                await work.click();
                await delivered.waitFor();
                await screenshot(page, "expanded-work");
                if (capture) {
                  await page.waitForTimeout(1500);
                }
                await work.click();
              }
              proof.providerRequests = provider.requests();
              proof.toolArguments = provider.toolArguments;
              proof.scenarioComplete = true;
              await saveProof();
              // Retain evidence first: base red must reach the actual marker/visibility boundary.
              expect(receipt.marker?.kind).toBe("message-tool-source-reply");
              if (continuing) {
                expect(receipt.marker?.final).toBe(false);
              } else {
                expect(Object.hasOwn(receipt.marker!, "final")).toBe(false);
              }
              expect(provider.requests()).toBe(continuing ? 2 : 1);
              expect(visibleAfterCompletion).toBe(true);
              expect(visibleAfterReload).toBe(true);
              expect(settledDeliveredVisible).toBe(true);
              if (continuing) {
                expect(settledAcknowledgmentVisible).toBe(true);
              }
              expect(await work.getAttribute("aria-expanded")).toBe("false");
              expect(await transcript.getByText(fixture.commentary, { exact: true }).count()).toBe(
                0,
              );
              expect(await delivered.count()).toBe(1);
              expect(provider.failures).toEqual([]);
              proof.complete = true;
              proof.stage = "complete";
            } finally {
              try {
                const lastHistory = await client.request<ChatHistoryResult>("chat.history", {
                  sessionKey: fixture.key,
                  limit: 50,
                });
                proof.lastHistory = deliveredRow(lastHistory);
                proof.lastRenderedReplyCount = await page
                  .locator(".chat-text")
                  .getByText(fixture.delivered, { exact: true })
                  .count();
                if (capture && (await page.locator(".chat-work-group button").count())) {
                  await screenshot(page, "last-observed");
                }
              } catch {
                proof.lastHistoryUnavailable = true;
              }
              let logs = instance.logs();
              for (const secret of [
                instance.gatewayToken,
                instance.hookToken,
                instance.homeDir,
                instance.stateDir,
                "synthetic-source-reply-key",
              ]) {
                logs = logs.replaceAll(secret, "[fixture-private]");
              }
              await fs.writeFile(path.join(artifactDir, "gateway.private.log"), logs);
              proof.sourcePublications = published;
              proof.rpc = wire.diagnostics();
              proof.providerRequests = provider.requests();
              proof.providerFailureCount = provider.failures.length;
              await saveProof();
              if (recording) {
                const result = await recording.finish();
                proof.recording = {
                  video: path.basename(result.videoPath),
                  cues: path.basename(result.cuesPath),
                };
                await saveProof();
              } else {
                await suite.closeBrowserContext(context);
              }
            }
          },
        });
      },
      120_000,
    );
  });
}
defineSourceReplyScenario(undefined);
defineSourceReplyScenario(false);
