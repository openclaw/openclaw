import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
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
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "sessions.create",
              "sessions.dispatch",
              "mcp.app.discover",
            ],
            methodResponses: { "mcp.app.discover": { servers: [] } },
          });
          await page.goto(`${suite.server.baseUrl}new?agent=main#draft-return`);
          if (incognito) {
            await page.getByRole("switch", { name: "Incognito" }).click();
          }
          await page.locator(".new-session-page__message").fill("start the synthetic thread");
          const originalUrl = page.url();
          const historyLength = await page.evaluate(() => history.length);
          await captureUiProof(suite, page, `instant-${incognito}-before.png`);
          await gateway.deferNext("sessions.create");
          await page.getByRole("button", { name: "Start session", exact: true }).click();
          const params = createParams(await gateway.waitForRequest("sessions.create"));
          await expect
            .poll(() => page.locator("openclaw-chat-page").count(), { timeout: 5_000 })
            .toBe(1);
          await expect
            .poll(() => page.locator(".chat-thread").textContent())
            .toContain("start the synthetic thread");
          expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
          await captureUiProof(suite, page, `instant-${incognito}-pending-chrome.png`);
          expect(await page.locator(".chat-pane__header").isVisible()).toBe(true);
          expect(await page.locator(".agent-chat__composer-combobox textarea").isVisible()).toBe(
            true,
          );
          expect(await page.locator(".agent-chat__composer-combobox textarea").isDisabled()).toBe(
            true,
          );
          await waitForControlUiProofSurface(page.locator(".chat-pane__header"), [
            page.locator(".agent-chat__composer-combobox textarea"),
            page.locator(".chat-group.user .chat-bubble"),
          ]);
          const pendingHeader = await page.locator(".chat-pane__header").boundingBox();
          const pendingComposer = await page.locator(".agent-chat__composer-shell").boundingBox();
          const pendingBubble = await page.locator(".chat-group.user .chat-bubble").boundingBox();
          expect(await page.locator(".chat-pane__incognito").count()).toBe(incognito ? 1 : 0);
          if (!incognito) {
            await page.locator(".chat-pane__nav-toggle").click();
            // The sliding drawer can hover a tooltip under the stationary pointer.
            await page.mouse.move(0, 0);
            await expect
              .poll(() => page.locator(".chat-pane__nav-toggle").getAttribute("aria-expanded"))
              .toBe("true");
            await page.keyboard.press("Escape");
            await expect
              .poll(() => page.locator(".chat-pane__nav-toggle").getAttribute("aria-expanded"))
              .toBe("false");
          }
          expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(
            (await gateway.getRequests("mcp.app.discover")).filter(
              (request) => createParams(request).sessionKey === params.key,
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
          const confirmedKey = canonicalReplacement
            ? "agent:main:canonical-instant-thread"
            : String(params.key);
          await gateway.resolveDeferred("sessions.create", {
            key: confirmedKey,
            runStarted: true,
            runId: "synthetic-initial-run",
          });
          await waitForCommittedChatRoute(page);
          expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(confirmedKey));
          await gateway.waitForRequest("chat.startup", { match: { sessionKey: confirmedKey } });
          await gateway.waitForRequest("mcp.app.discover", { match: { sessionKey: confirmedKey } });
          await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(1);
          expect(await gateway.getRequests("chat.startup")).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                params: expect.objectContaining({ sessionKey: confirmedKey }),
              }),
            ]),
          );
          expect(
            (await gateway.getRequests("chat.startup")).every(
              (request) => createParams(request).sessionKey === confirmedKey,
            ),
          ).toBe(true);
          expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
          await expect
            .poll(() => page.locator(".chat-thread").textContent())
            .toContain("start the synthetic thread");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          await captureUiProof(suite, page, `instant-${incognito}-committed.png`);
          await waitForControlUiProofSurface(page.locator(".chat-pane__header"), [
            page.locator(".agent-chat__composer-combobox textarea"),
            page.locator(".chat-group.user .chat-bubble"),
          ]);
          for (const [selector, pending] of [
            [".chat-pane__header", pendingHeader],
            [".agent-chat__composer-shell", pendingComposer],
            [".chat-group.user .chat-bubble", pendingBubble],
          ] as const) {
            const committed = await page.locator(selector).boundingBox();
            expect(pending).not.toBeNull();
            expect(committed).not.toBeNull();
            expect(committed!.y).toBeCloseTo(pending!.y, 0);
            expect(committed!.x).toBeCloseTo(pending!.x, 0);
          }
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
        const gateway = await installMockGateway(page, {
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
        const composer = page.locator(".new-session-page__message");
        await composer.fill("  preserve my full draft  ");
        await page.locator(".agent-chat__photo-input").setInputFiles({
          name: "synthetic-pixel.png",
          mimeType: "image/png",
          buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        });
        await page.getByRole("button", { name: "Open image synthetic-pixel.png" }).waitFor();
        if (incognito) {
          await page.getByRole("switch", { name: "Incognito" }).click();
        }
        await page.locator("#new-session-checkout-trigger").click();
        await page
          .locator('wa-popover.new-session-page__checkout-popover [data-value="worktree"]')
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
        await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          app.runtime.context.agentSelection.set("main");
        });
        const originalUrl = page.url();
        const historyLength = await page.evaluate(() => history.length);
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const first = createParams(await gateway.waitForRequest("sessions.create"));
        expect(first.agentId).toBe(requestedAgent);
        await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
        await gateway.rejectDeferred("sessions.create", {
          code: "UNAVAILABLE",
          message: "Synthetic admission refused",
        });
        await expect.poll(() => composer.inputValue()).toBe("  preserve my full draft  ");
        await expect
          .poll(() => page.locator("openclaw-new-session-page").textContent())
          .toContain("Synthetic admission refused");
        expect(page.url()).toBe(originalUrl);
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        expect(
          await page.getByRole("switch", { name: "Incognito" }).getAttribute("aria-checked"),
        ).toBe(String(incognito));
        expect(
          await page.getByRole("button", { name: "Open image synthetic-pixel.png" }).count(),
        ).toBe(1);
        await captureUiProof(suite, page, `instant-${incognito}-cross-${crossAgent}-rollback.png`);
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const second = createParams(await gateway.waitForRequest("sessions.create", { after: 1 }));
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
        await navigateInApp(page, "new-session", "?agent=main");
        await expect.poll(() => composer.inputValue()).toBe("");
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
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await page.locator(".new-session-page__message").fill(submitted);
        await gateway.deferNext("sessions.create");
        if (readiness) {
          await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: ApplicationContext };
            };
            const context = app.runtime.context;
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
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const first = createParams(await gateway.waitForRequest("sessions.create"));
        await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
        if (readiness) {
          await gateway.resolveDeferred("sessions.create", { key: first.key });
          await page.waitForFunction(
            () =>
              (window as Window & { instantReadyGate?: { entered: boolean } }).instantReadyGate
                ?.entered,
          );
        }
        await navigateInApp(page, "new-session", "?agent=main");
        const composer = page.locator(".new-session-page__message");
        if (readiness) {
          // Wait for the retained draft before fill selects and replaces it.
          await expect.poll(() => composer.inputValue()).toBe(submitted);
        }
        await composer.fill(message);
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
          expect(await composer.inputValue()).toBe(message);
          expect(page.url()).toBe(newerUrl);
        }
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const second = createParams(await gateway.waitForRequest("sessions.create", { after: 1 }));
        expect(second.message).toBe(message);
        expect(second.key).not.toBe(first.key);
        await gateway.rejectDeferred("sessions.create", {
          message: readiness ? "Return the newer draft" : "New admission refused",
        });
        await expect.poll(() => composer.inputValue()).toBe(message);
        expect(page.url()).toBe(newerUrl);
      });
    },
  );

  it("resumes a transport interruption with the same frozen startup request", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main#reconnect`);
      await page.locator(".new-session-page__message").fill("resume exactly once");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const first = createParams(await gateway.waitForRequest("sessions.create"));
      await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
      await gateway.setOnline(false);
      await captureUiProof(suite, page, "submitted-prompt-during-reconnect.png");
      await expect
        .poll(() => page.locator("openclaw-pending-session-create").textContent())
        .toContain("resume exactly once");
      await expect
        .poll(() => page.locator("openclaw-pending-session-create").textContent())
        .toContain("Reconnecting");
      await gateway.deferNext("sessions.create");
      await gateway.setOnline(true);
      const second = createParams(await gateway.waitForRequest("sessions.create", { after: 1 }));
      expect(second).toEqual(first);
      // Deferred responses are FIFO, including the retired socket. Release
      // both explicitly so the resumed request receives its own response.
      await gateway.resolveDeferred("sessions.create", { key: second.key });
      await gateway.resolveDeferred("sessions.create", { key: second.key });
      await waitForCommittedChatRoute(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
    });
  });

  it.each([
    { change: "gateway", message: "private old-identity text" },
    { change: "principal", message: "private first principal" },
    { change: "boot", message: "do not duplicate this admission" },
  ] as const)(
    "fences interrupted admission after a $change change",
    async ({ change, message }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new?agent=main${change === "boot" ? "#boot" : ""}`);
        if (change !== "boot") {
          await page.getByRole("switch", { name: "Incognito" }).click();
        }
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        const originalUrl = page.url();
        const hello = await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          return app.runtime.context.gateway.snapshot.hello!;
        });
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        await gateway.waitForRequest("sessions.create");
        await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
        if (change === "gateway") {
          await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: ApplicationContext };
            };
            app.runtime.context.gateway.connect({
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
        } else {
          await expect.poll(() => page.locator("openclaw-new-session-page").count()).toBe(1);
          await expect.poll(() => composer.inputValue()).toBe("");
          expect(await page.locator("openclaw-new-session-page").textContent()).not.toContain(
            message,
          );
        }
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
            const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
              ?.value as Storage["setItem"];
            Storage.prototype.setItem = function (key: string, value: string) {
              if (key.startsWith("openclaw.control.chatComposer.v2:")) {
                throw new DOMException("Synthetic quota", "QuotaExceededError");
              }
              return setItem.call(this, key, value);
            };
          });
        }
        const gateway = await installMockGateway(page, {
          methodResponses: { "chat.send": { runId: "synthetic-retry", status: "started" } },
        });
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await page.locator(".new-session-page__message").fill("retry this first turn");
        await page.locator(".agent-chat__photo-input").setInputFiles({
          name: "synthetic-pixel.png",
          mimeType: "image/png",
          buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        });
        await page.getByRole("button", { name: "Open image synthetic-pixel.png" }).waitFor();
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const params = createParams(await gateway.waitForRequest("sessions.create"));
        await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
        await gateway.resolveDeferred("sessions.create", {
          key: params.key,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: "Synthetic initial turn refused" },
        });
        await waitForCommittedChatRoute(page);
        const failed = page.locator(".chat-group.user", { hasText: "retry this first turn" });
        await expect
          .poll(() => failed.locator(".chat-send-status").textContent())
          .toContain("Not sent");
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
        const gateway = await installMockGateway(page);
        await page.goto(
          `${suite.server.baseUrl}new?agent=main${stage === "committed" ? "#navigation-error" : ""}`,
        );
        const message =
          stage === "preview" ? "keep the confirmed creation" : "create this session only once";
        await page.locator(".new-session-page__message").fill(message);
        if (stage === "preview") {
          await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: ApplicationContext };
            };
            const context = app.runtime.context;
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
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const params = createParams(await gateway.waitForRequest("sessions.create"));
        if (stage === "committed") {
          await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
          await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: ApplicationContext };
            };
            const context = app.runtime.context;
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
          await expect
            .poll(() => page.locator("openclaw-new-session-page").textContent())
            .toContain("Synthetic committed route failed");
          await captureUiProof(suite, page, "submitted-prompt-after-navigation-failure.png");
          await expect
            .poll(() => page.locator(".new-session-page__starting").textContent())
            .toContain(message);
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
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator(".new-session-page__message").fill("legacy scope still starts");
      const hello = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: ApplicationContext };
        };
        return app.runtime.context.gateway.snapshot.hello!;
      });
      await gateway.setMethodResponse("connect", {
        ...hello,
        auth: { role: hello.auth?.role, scopes: hello.auth?.scopes },
      });
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await page.waitForFunction(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: ApplicationContext };
        };
        const snapshot = app.runtime.context.gateway.snapshot;
        return snapshot.phase === "connected" && !snapshot.hello?.auth?.recoveryScope;
      });
      const composer = page.locator(".new-session-page__message");
      await composer.fill("legacy scope still starts");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await gateway.waitForRequest("sessions.create");
      expect(await page.locator("openclaw-chat-page").count()).toBe(0);
      await gateway.resolveDeferred("sessions.create", {
        key: "agent:main:dashboard:legacy-scope",
      });
      await waitForCommittedChatRoute(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
});
