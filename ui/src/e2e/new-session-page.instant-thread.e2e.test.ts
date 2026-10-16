import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  pollText,
  pollAttribute,
  pollValue,
  pollCount,
  ONE_PIXEL_PNG_B64,
  captureUiProof,
  checkoutBaseRefInput,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

function createParams(request: { params?: unknown }): Record<string, unknown> {
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new Error("sessions.create must carry an object");
  }
  return request.params as Record<string, unknown>;
}

async function createThread(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  const gateway = await installMockGateway(page, scenario);
  const composer = page.locator(".new-session-page__message");
  const followUpComposer = page.locator(
    ".agent-chat__composer-combobox textarea:not(.new-session-page__message)",
  );
  async function submit(after?: number) {
    await page.getByRole("button", { name: "Start session", exact: true }).click();
    return createParams(
      await gateway.waitForRequest("sessions.create", after === undefined ? undefined : { after }),
    );
  }
  return {
    gateway,
    composer,
    followUpComposer,
    submit,
    async start() {
      await gateway.deferNext("sessions.create");
      const params = await submit();
      await pollCount(page.locator("openclaw-chat-page")).toBe(1);
      return params;
    },
    async queue(message: string) {
      await followUpComposer.fill(message);
      await followUpComposer.press("Enter");
      await page.locator(".chat-queue__item", { hasText: message }).waitFor();
    },
    async attachPhoto() {
      await page.locator(".agent-chat__photo-input").setInputFiles({
        name: "synthetic-pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      });
      await page.getByRole("button", { name: "Open image synthetic-pixel.png" }).waitFor();
    },
  };
}

suite.define(() => {
  it.each([
    { incognito: false, canonicalReplacement: false },
    { incognito: true, canonicalReplacement: true },
  ])(
    "attaches chat before admission and commits only the confirmed URL (incognito: $incognito, replacement: $canonicalReplacement)",
    async ({ incognito, canonicalReplacement }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: incognito ? { width: 1280, height: 800 } : { width: 390, height: 844 },
        },
        async ({ page }) => {
          const { gateway, composer, followUpComposer, submit, queue } = await createThread(page, {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "sessions.create",
              "sessions.dispatch",
              "mcp.app.discover",
            ],
            methodResponses: { "mcp.app.discover": { servers: [] } },
          });
          const requests = async (method: string) =>
            (await gateway.getRequests(method)).map(createParams);
          const header = page.locator(".chat-pane__header");
          const bubble = page.locator(".chat-group.user .chat-bubble");
          const navToggle = page.locator(".chat-pane__nav-toggle");
          const queueText = page.locator(".chat-queue__text");
          const geometry = [header, page.locator(".agent-chat__composer-shell"), bubble];
          const settledGeometry = async () => {
            await waitForControlUiProofSurface(header, [followUpComposer, bubble]);
            return Promise.all(geometry.map((element) => element.boundingBox()));
          };
          await page.goto(`${suite.server.baseUrl}new?agent=main#draft-return`);
          if (incognito) {
            await page.getByRole("switch", { name: "Incognito" }).click();
          }
          await composer.fill("start the synthetic thread");
          const originalUrl = page.url();
          const historyLength = await page.evaluate(() => history.length);
          await captureUiProof(suite, page, `instant-${incognito}-before.png`);
          await gateway.deferNext("sessions.create");
          const params = await submit();
          await expect
            .poll(() => page.locator("openclaw-chat-page").count(), { timeout: 5_000 })
            .toBe(1);
          await pollText(page.locator(".chat-thread")).toContain("start the synthetic thread");
          expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
          await captureUiProof(suite, page, `instant-${incognito}-pending-chrome.png`);
          expect(await header.isVisible()).toBe(true);

          await followUpComposer.waitFor({ state: "visible" });
          expect(await followUpComposer.isEnabled()).toBe(true);
          const followers = ["Also check keyboard navigation", "Then verify the mobile layout"];
          for (const message of followers) {
            await queue(message);
          }
          await followUpComposer.fill("Still writing my next message");
          expect(await queueText.allTextContents()).toEqual(followers);
          expect(await page.locator(".chat-pane__incognito").count()).toBe(incognito ? 1 : 0);
          if (!incognito) {
            await navToggle.click();
            // The sliding drawer can hover a tooltip under the stationary pointer.
            await page.mouse.move(0, 0);
            await pollAttribute(navToggle, "aria-expanded").toBe("true");
            await page.keyboard.press("Escape");
            await pollAttribute(navToggle, "aria-expanded").toBe("false");
          }
          expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          expect(
            (await requests("mcp.app.discover")).filter(
              (request) => request.sessionKey === params.key,
            ),
          ).toHaveLength(0);
          expect(page.url()).toBe(originalUrl);
          expect(await page.evaluate(() => history.length)).toBe(historyLength);
          expect(params.key).toEqual(
            expect.stringMatching(
              incognito ? /^agent:main:dashboard:incognito-/u : /^agent:main:dashboard:/u,
            ),
          );
          expect(params.incognito === true).toBe(incognito);
          const savedSettings = await page.evaluate(() =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("openclaw.control.settings.v1"))
              .map((key) => localStorage.getItem(key)),
          );
          expect(savedSettings.join("\n")).not.toContain(String(params.key));

          await captureUiProof(suite, page, `instant-${incognito}-pending.png`);
          const pendingGeometry = await settledGeometry();
          const confirmedKey = canonicalReplacement
            ? "agent:main:dashboard:incognito-canonical-instant-thread"
            : String(params.key);
          await gateway.resolveDeferred("sessions.create", {
            key: confirmedKey,
            ...(incognito ? { entry: { incognito: true } } : {}),
            runStarted: true,
            runId: "synthetic-initial-run",
          });
          await waitForCommittedChatRoute(page);
          expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(confirmedKey));
          await gateway.waitForRequest("chat.startup", { match: { sessionKey: confirmedKey } });
          await gateway.waitForRequest("mcp.app.discover", { match: { sessionKey: confirmedKey } });
          await pollCount(page.locator("openclaw-chat-pane")).toBe(1);
          expect(
            (await requests("chat.startup")).every(
              (request) => request.sessionKey === confirmedKey,
            ),
          ).toBe(true);
          expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
          await pollText(page.locator(".chat-thread")).toContain("start the synthetic thread");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          await pollValue(followUpComposer).toBe("Still writing my next message");
          await expect.poll(() => queueText.allTextContents()).toEqual(followers);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await captureUiProof(suite, page, `instant-${incognito}-committed.png`);
          const committedGeometry = await settledGeometry();
          for (const selector of [".chat-pane__incognito", ".chat-pane__incognito-notice"]) {
            expect(await page.locator(selector).isVisible()).toBe(incognito);
          }
          for (const [index, pending] of pendingGeometry.entries()) {
            const committed = committedGeometry[index];
            expect(pending).not.toBeNull();
            expect(committed).not.toBeNull();
            expect(committed!.y).toBeCloseTo(pending!.y, 0);
            expect(committed!.x).toBeCloseTo(pending!.x, 0);
          }
          await gateway.emitChatFinal({
            sessionKey: confirmedKey,
            runId: "synthetic-initial-run",
            text: "Initial task finished.",
          });
          for (const [index, message] of followers.entries()) {
            const request = await gateway.waitForRequest("chat.send", { after: index });
            const send = createParams(request);
            expect(send).toMatchObject({ sessionKey: confirmedKey, message });
            await gateway.emitChatFinal({
              sessionKey: confirmedKey,
              runId: String(send.idempotencyKey),
              text: `Follow-up ${index + 1} finished.`,
            });
          }
          expect((await requests("chat.send")).map((request) => request.message)).toEqual(
            followers,
          );
          expect(await followUpComposer.inputValue()).toBe("Still writing my next message");
        },
      );
    },
  );

  it.each([
    { incognito: false, crossAgent: false },
    { incognito: true, crossAgent: true },
  ])(
    "restores the full draft and exact URL after rejection (incognito: $incognito, cross-agent: $crossAgent)",
    async ({ incognito, crossAgent }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, composer, followUpComposer, submit, start, queue, attachPhoto } =
          await createThread(page, {
            workspace: "/tmp/synthetic-workspace",
            workspaceGit: true,
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "sessions.create",
              "sessions.dispatch",
              "worktrees.branches",
            ],
            models: [
              {
                id: "synthetic-model",
                name: "Synthetic Model",
                provider: "synthetic",
                reasoning: true,
              },
            ],
            methodResponses: {
              "agents.list": {
                agents: ["main", "research"].map((id) => ({
                  id,
                  name: id,
                  workspace: "/tmp/synthetic-workspace",
                  workspaceGit: true,
                })),
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              "worktrees.branches": {
                branches: [
                  { kind: "local", name: "main" },
                  { kind: "local", name: "release/proof" },
                ],
                defaultBranch: "main",
                repositoryStatus: "git",
              },
            },
          });
        const requestedAgent = crossAgent ? "research" : "main";
        await page.goto(`${suite.server.baseUrl}new?agent=${requestedAgent}#keep-exact-fragment`);

        await composer.fill("  preserve my full draft  ");
        await attachPhoto();
        if (incognito) {
          await page.getByRole("switch", { name: "Incognito" }).click();
        }
        await page.locator("#new-session-checkout-trigger").click();
        await page
          .locator('.oc-popover.new-session-page__checkout-popover [data-value="worktree"]')
          .click();
        await checkoutBaseRefInput(page).fill("release/proof");
        await page.getByLabel("Name", { exact: true }).fill("instant-proof");
        await page.keyboard.press("Escape");
        await page.locator('[data-chat-model-select="true"]').click();
        await selectChatModelOption(
          page.locator('[data-chat-model-option="synthetic/synthetic-model"]'),
        );
        await page.locator('[data-chat-permission-select="true"]').click();
        await page.locator('[data-chat-permission-option="full"]').click();
        await evaluateControlUiContext(page, (application) => {
          application.agentSelection.set("main");
        });
        const originalUrl = page.url();
        const historyLength = await page.evaluate(() => history.length);
        const first = await start();
        expect(first.agentId).toBe(requestedAgent);

        await queue("Preserve this follow-up too");
        await followUpComposer.fill("Unfinished follow-up draft");
        await gateway.rejectDeferred("sessions.create", {
          code: "UNAVAILABLE",
          message: "Synthetic admission refused",
        });
        await pollValue(composer).toBe("  preserve my full draft  ");
        await pollText(page.locator("openclaw-new-session-page")).toContain(
          "Synthetic admission refused",
        );
        expect(page.url()).toBe(originalUrl);
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        expect(await followUpComposer.inputValue()).toBe("Unfinished follow-up draft");
        expect(await page.locator(".chat-queue__text").allTextContents()).toEqual([
          "Preserve this follow-up too",
        ]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(
          await page.getByRole("switch", { name: "Incognito" }).getAttribute("aria-checked"),
        ).toBe(String(incognito));
        expect(
          await page.getByRole("button", { name: "Open image synthetic-pixel.png" }).count(),
        ).toBe(1);
        await captureUiProof(suite, page, `instant-${incognito}-cross-${crossAgent}-rollback.png`);
        await gateway.deferNext("sessions.create");
        const second = await submit(1);
        expect(second).toMatchObject({
          message: "preserve my full draft",
          model: "synthetic/synthetic-model",
          permissionMode: "full",
          worktree: true,
          worktreeBaseRef: "release/proof",
          worktreeName: "instant-proof",
        });
        const { key: firstKey, idempotencyKey: firstId, ...firstDraft } = first;
        const { key: secondKey, idempotencyKey: secondId, ...secondDraft } = second;
        expect(secondDraft).toEqual(firstDraft);
        expect(secondDraft.attachments).toEqual(
          expect.arrayContaining([expect.objectContaining({ mimeType: "image/png" })]),
        );
        expect(secondKey).not.toBe(firstKey);
        expect(secondId).not.toBe(firstId);
        await gateway.resolveDeferred("sessions.create", { key: secondKey });
        await waitForCommittedChatRoute(page);
        await pollValue(followUpComposer).toBe("Unfinished follow-up draft");
        expect(createParams(await gateway.waitForRequest("chat.send"))).toMatchObject({
          sessionKey: secondKey,
          message: "Preserve this follow-up too",
        });
        await navigateInApp(page, "new-session", "?agent=main");
        await pollValue(composer).toBe("");
      });
    },
  );

  it.each(["foreground create", "preview readiness"] as const)(
    "keeps a newer draft in charge of late %s completion",
    async (stage) => {
      const readiness = stage === "preview readiness";
      const submitted = readiness ? "old admission" : "old submitted text";
      const message = readiness ? "newer during pending readiness" : "new draft must win";
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, composer, submit, start } = await createThread(page);
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await composer.fill(submitted);
        if (readiness) {
          await evaluateControlUiContext(page, (context) => {
            const original = context.router.navigate.bind(context.router);
            const gate = { entered: false, release: () => {} };
            const wait = new Promise<void>((resolve) => {
              gate.release = resolve;
            });
            Object.defineProperty(window, "instantReadyGate", { value: gate, configurable: true });
            Object.defineProperty(context.router, "navigate", {
              configurable: true,
              value: (...args: Parameters<typeof original>) => {
                const transition = original(...args);
                return args[2]?.history === "none"
                  ? transition.then(async () => {
                      gate.entered = true;
                      await wait;
                    })
                  : transition;
              },
            });
          });
        }
        const first = await start();
        if (readiness) {
          await gateway.resolveDeferred("sessions.create", { key: first.key });
          await page.waitForFunction(
            () =>
              (window as Window & { instantReadyGate?: { entered: boolean } }).instantReadyGate
                ?.entered,
          );
        }
        await navigateInApp(page, "new-session", "?agent=main");
        await waitForControlUiRoute(page, {
          routeId: "new-session",
          pathname: "/new",
          search: "?agent=main",
        });
        await page.locator("openclaw-new-session-page").evaluate(async (element) => {
          // SAFETY: This registered Solid bridge exposes its mount completion promise.
          await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
        });

        if (readiness) {
          // Accepted input retires even while preview readiness is pending.
          await pollValue(composer).toBe("");
        }
        await composer.fill(message);
        await pollValue(composer).toBe(message);
        const newerUrl = page.url();
        if (readiness) {
          await page.evaluate(() =>
            (
              window as Window & { instantReadyGate?: { release: () => void } }
            ).instantReadyGate?.release(),
          );
        } else {
          await gateway.resolveDeferred("sessions.create", {
            key: first.key,
            runStarted: true,
            runId: "late-old-run",
          });
          await gateway.waitForRequest("sessions.list");
        }
        expect(await composer.inputValue()).toBe(message);
        expect(page.url()).toBe(newerUrl);
        await gateway.deferNext("sessions.create");
        const second = await submit(1);
        expect(second.message).toBe(message);
        expect(second.key).not.toBe(first.key);
        await gateway.rejectDeferred("sessions.create", {
          message: readiness ? "Return the newer draft" : "New admission refused",
        });
        await pollValue(composer).toBe(message);
        expect(page.url()).toBe(newerUrl);
      });
    },
  );

  it("resumes a transport interruption with the same frozen startup request", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, composer, followUpComposer, start, queue } = await createThread(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main#reconnect`);
      await composer.fill("resume exactly once");
      const first = await start();

      await queue("Queued before reconnect");
      await followUpComposer.fill("Draft survives reconnect");
      await gateway.setOnline(false);
      await captureUiProof(suite, page, "submitted-prompt-during-reconnect.png");
      await pollText(page.locator("openclaw-pending-session-create")).toContain(
        "resume exactly once",
      );
      await pollText(page.locator("openclaw-pending-session-create")).toContain("Reconnecting");
      await gateway.deferNext("sessions.create");
      await gateway.setOnline(true);
      const second = createParams(await gateway.waitForRequest("sessions.create", { after: 1 }));
      expect(second).toEqual(first);
      // Deferred responses are FIFO, including the retired socket. Release
      // both explicitly so the resumed request receives its own response.
      await gateway.resolveDeferred("sessions.create", { key: second.key });
      await gateway.resolveDeferred("sessions.create", { key: second.key });
      await waitForCommittedChatRoute(page);
      await pollValue(followUpComposer).toBe("Draft survives reconnect");
      expect(createParams(await gateway.waitForRequest("chat.send"))).toMatchObject({
        sessionKey: second.key,
        message: "Queued before reconnect",
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
    });
  });

  it.each([
    { change: "gateway", message: "private old-identity text", followUps: true },
    { change: "principal", message: "private first principal", followUps: true },
    { change: "boot", message: "do not duplicate this admission", followUps: true },
    { change: "boot", message: "keep the interrupted task draft", followUps: false },
  ] as const)(
    "fences interrupted admission after a $change change (follow-ups: $followUps)",
    async ({ change, message, followUps }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, composer, followUpComposer, start, queue } = await createThread(page);
        await page.goto(`${suite.server.baseUrl}new?agent=main${change === "boot" ? "#boot" : ""}`);
        if (change !== "boot") {
          await page.getByRole("switch", { name: "Incognito" }).click();
        }

        await composer.fill(message);
        const originalUrl = page.url();
        const hello = await evaluateControlUiContext(
          page,
          (application) => application.gateway.snapshot.hello!,
        );
        await start();

        if (followUps) {
          await queue("private staged follow-up");
          await followUpComposer.fill("private unfinished follow-up");
        }
        if (change === "gateway") {
          await evaluateControlUiContext(page, (application) => {
            application.gateway.connect({
              gatewayUrl: "ws://other-synthetic-gateway.invalid",
              token: "",
            });
          });
        } else {
          if (change === "principal") {
            await gateway.setMethodResponse("connect", {
              ...hello,
              auth: { ...hello.auth, recoveryScope: "different-synthetic-principal" },
            });
          } else {
            await gateway.setGatewayBootId("different-synthetic-boot");
          }
          await gateway.setOnline(false);
          if (change === "principal") {
            expect(await page.locator("openclaw-new-session-page").count()).toBe(0);
          }
          await gateway.setOnline(true);
        }
        if (change === "boot") {
          await page
            .getByRole("alert")
            .filter({ hasText: "The Gateway changed while this session was starting" })
            .waitFor();
          expect(await composer.inputValue()).toBe(message);
          expect(
            await page.getByRole("button", { name: "Start session", exact: true }).isDisabled(),
          ).toBe(true);
          expect(page.url()).toBe(originalUrl);
          await captureUiProof(suite, page, `interrupted-boot-follow-ups-${followUps}.png`);
          if (followUps) {
            expect(await followUpComposer.inputValue()).toBe("private unfinished follow-up");
            expect(await page.locator(".chat-queue__text").allTextContents()).toEqual([
              "private staged follow-up",
            ]);
          } else {
            expect(await page.locator(".creation-composer").count()).toBe(0);
            expect(await page.locator("textarea:visible").count()).toBe(1);
          }
        } else {
          await pollCount(page.locator("openclaw-new-session-page")).toBe(1);
          await pollValue(composer).toBe("");
          expect(await page.locator("openclaw-new-session-page").textContent()).not.toContain(
            message,
          );
        }
        if (change !== "boot") {
          expect(await page.locator("openclaw-new-session-page").textContent()).not.toContain(
            "private staged follow-up",
          );
          expect(
            await page
              .locator("textarea")
              .evaluateAll((inputs) =>
                inputs.map((input) => (input instanceof HTMLTextAreaElement ? input.value : "")),
              ),
          ).not.toContain("private unfinished follow-up");
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      });
    },
  );
  it.each([false, true])(
    "keeps late rejected first-turn attachments retryable (storage failure: %s)",
    async (storageFailure) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        if (storageFailure) {
          await page.addInitScript(() => {
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key: string, value: string) {
              if (key.startsWith("openclaw.control.chatComposer.v2:")) {
                throw new DOMException("Synthetic quota", "QuotaExceededError");
              }
              return setItem.call(this, key, value);
            };
          });
        }
        const { gateway, composer, start, attachPhoto } = await createThread(page, {
          methodResponses: { "chat.send": { runId: "synthetic-retry", status: "started" } },
        });
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await composer.fill("retry this first turn");
        await attachPhoto();
        const params = await start();
        await gateway.resolveDeferred("sessions.create", {
          key: params.key,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: "Synthetic initial turn refused" },
        });
        await waitForCommittedChatRoute(page);
        const failed = page.locator(".chat-group.user", { hasText: "retry this first turn" });
        await pollText(failed.locator(".chat-send-status")).toContain("Not sent");
        await page.getByRole("button", { name: "Retry queued message" }).click();
        expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
          sessionKey: params.key,
          message: "retry this first turn",
          attachments: [{ fileName: "synthetic-pixel.png", content: ONE_PIXEL_PNG_B64 }],
        });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      });
    },
  );

  it.each(["preview", "committed"] as const)(
    "adopts a confirmed create after a %s navigation failure without recreating it",
    async (stage) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, composer, submit } = await createThread(page);
        await page.goto(
          `${suite.server.baseUrl}new?agent=main${stage === "committed" ? "#navigation-error" : ""}`,
        );
        const message =
          stage === "preview" ? "keep the confirmed creation" : "create this session only once";
        await composer.fill(message);
        if (stage === "preview") {
          await evaluateControlUiContext(page, (context) => {
            const original = context.router.navigate.bind(context.router);
            Object.defineProperty(context.router, "navigate", {
              configurable: true,
              value: (...args: Parameters<typeof original>) => {
                const transition = original(...args);
                return args[0] === "chat" && args[2]?.history === "none"
                  ? transition.then(() => {
                      throw new Error("Synthetic preview readiness failed");
                    })
                  : transition;
              },
            });
          });
        }
        await gateway.deferNext("sessions.create");
        const params = await submit();
        if (stage === "committed") {
          await pollCount(page.locator("openclaw-chat-page")).toBe(1);
          await evaluateControlUiContext(page, (context) => {
            const original = context.navigateAndWait;
            Object.defineProperty(context, "navigateAndWait", {
              configurable: true,
              value: async () => {
                Object.defineProperty(context, "navigateAndWait", {
                  configurable: true,
                  value: original,
                });
                throw new Error("Synthetic committed route failed");
              },
            });
          });
        }
        await gateway.resolveDeferred("sessions.create", { key: params.key });
        if (stage === "committed") {
          await pollText(page.locator("openclaw-new-session-page")).toContain(
            "Synthetic committed route failed",
          );
          await captureUiProof(suite, page, "submitted-prompt-after-navigation-failure.png");
          await pollText(page.locator(".new-session-page__starting")).toContain(message);
          await page.getByRole("button", { name: "Open session", exact: true }).click();
        }
        await waitForCommittedChatRoute(page);
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(String(params.key)));
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      });
    },
  );

  it("keeps the existing draft flow when the Gateway has no authenticated recovery scope", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, composer, submit } = await createThread(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await composer.fill("legacy scope still starts");
      const hello = await evaluateControlUiContext(
        page,
        (application) => application.gateway.snapshot.hello!,
      );
      await gateway.setMethodResponse("connect", {
        ...hello,
        auth: { role: hello.auth?.role, scopes: hello.auth?.scopes },
      });
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await expect
        .poll(() =>
          evaluateControlUiContext(page, (application) => {
            const snapshot = application.gateway.snapshot;
            return snapshot.phase === "connected" && !snapshot.hello?.auth?.recoveryScope;
          }),
        )
        .toBe(true);

      await composer.fill("legacy scope still starts");
      await gateway.deferNext("sessions.create");
      await submit();
      expect(await page.locator("openclaw-chat-page").count()).toBe(0);
      await gateway.resolveDeferred("sessions.create", {
        key: "agent:main:dashboard:legacy-scope",
      });
      await waitForCommittedChatRoute(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
});
