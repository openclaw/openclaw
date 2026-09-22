import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  ONE_PIXEL_PNG_B64,
  captureUiProof,
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
    { incognito: true, canonicalReplacement: false },
    { incognito: false, canonicalReplacement: true },
    { incognito: true, canonicalReplacement: true },
  ])(
    "attaches chat before admission and commits only the confirmed URL (incognito: $incognito, replacement: $canonicalReplacement)",
    async ({ incognito, canonicalReplacement }) => {
      const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      try {
        const page = await browser.newPage();
        const gateway = await installMockGateway(page);
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
        expect(await page.locator(".chat-compose textarea").count()).toBe(0);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
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
      } finally {
        await browser.close();
      }
    },
  );

  it.each([
    { incognito: false, crossAgent: false },
    { incognito: true, crossAgent: false },
    { incognito: false, crossAgent: true },
    { incognito: true, crossAgent: true },
  ])(
    "restores the full draft and exact URL after rejection (incognito: $incognito, cross-agent: $crossAgent)",
    async ({ incognito, crossAgent }) => {
      const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      try {
        const page = await browser.newPage();
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
        await page.getByLabel("From", { exact: true }).fill("release/proof");
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
      } finally {
        await browser.close();
      }
    },
  );

  it("lets a newer draft win over a late successful foreground create", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator(".new-session-page__message").fill("old submitted text");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const first = createParams(await gateway.waitForRequest("sessions.create"));
      await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
      await navigateInApp(page, "new-session", "?agent=main");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("new draft must win");
      const newerUrl = page.url();
      await gateway.resolveDeferred("sessions.create", {
        key: first.key,
        runStarted: true,
        runId: "late-old-run",
      });
      await gateway.waitForRequest("sessions.list");
      expect(await composer.inputValue()).toBe("new draft must win");
      expect(page.url()).toBe(newerUrl);
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const second = createParams(await gateway.waitForRequest("sessions.create", { after: 1 }));
      expect(second.message).toBe("new draft must win");
      expect(second.key).not.toBe(first.key);
      await gateway.rejectDeferred("sessions.create", { message: "New admission refused" });
      await expect.poll(() => composer.inputValue()).toBe("new draft must win");
      expect(page.url()).toBe(newerUrl);
    } finally {
      await browser.close();
    }
  });

  it("resumes a transport interruption with the same frozen startup request", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
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
    } finally {
      await browser.close();
    }
  });

  it("does not restore old-identity draft bytes after switching Gateways", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("switch", { name: "Incognito" }).click();
      await page.locator(".new-session-page__message").fill("private old-identity text");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await gateway.waitForRequest("sessions.create");
      await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: ApplicationContext };
        };
        app.runtime.context.gateway.connect({
          gatewayUrl: "ws://other-synthetic-gateway.invalid",
          token: "",
        });
      });
      await expect.poll(() => page.locator("openclaw-new-session-page").count()).toBe(1);
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      expect(await page.locator("openclaw-new-session-page").textContent()).not.toContain(
        "private old-identity text",
      );
    } finally {
      await browser.close();
    }
  });
  it("keeps newer navigation in charge while the pending chat becomes ready", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator(".new-session-page__message").fill("old admission");
      await gateway.deferNext("sessions.create");
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
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const params = createParams(await gateway.waitForRequest("sessions.create"));
      await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
      await gateway.resolveDeferred("sessions.create", { key: params.key });
      await page.waitForFunction(
        () =>
          (window as Window & { instantReadyGate?: { entered: boolean } }).instantReadyGate
            ?.entered,
      );
      await navigateInApp(page, "new-session", "?agent=main");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("newer during pending readiness");
      const newerUrl = page.url();
      await page.evaluate(() =>
        (
          window as Window & { instantReadyGate?: { release: () => void } }
        ).instantReadyGate?.release(),
      );
      // A subsequent submit must originate in the newer draft, not a stolen chat.
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const second = createParams(await gateway.waitForRequest("sessions.create", { after: 1 }));
      expect(second.message).toBe("newer during pending readiness");
      await gateway.rejectDeferred("sessions.create", { message: "Return the newer draft" });
      await expect.poll(() => composer.inputValue()).toBe("newer during pending readiness");
      expect(page.url()).toBe(newerUrl);
    } finally {
      await browser.close();
    }
  });

  it("waits for authenticated scope before restoring an interrupted private draft", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("switch", { name: "Incognito" }).click();
      await page.locator(".new-session-page__message").fill("private first principal");
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
      await gateway.setMethodResponse("connect", {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "different-synthetic-principal" },
      });
      await gateway.setOnline(false);
      expect(await page.locator("openclaw-new-session-page").count()).toBe(0);
      await gateway.setOnline(true);
      await expect.poll(() => page.locator("openclaw-new-session-page").count()).toBe(1);
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  it("preserves the draft but never replays admission after a Gateway boot change", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main#boot`);
      await page.locator(".new-session-page__message").fill("do not duplicate this admission");
      const originalUrl = page.url();
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await gateway.waitForRequest("sessions.create");
      await expect.poll(() => page.locator("openclaw-chat-page").count()).toBe(1);
      await gateway.setGatewayBootId("different-synthetic-boot");
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await page
        .getByRole("alert")
        .filter({ hasText: "The Gateway changed while this session was starting" })
        .waitFor();
      expect(await page.locator(".new-session-page__message").inputValue()).toBe(
        "do not duplicate this admission",
      );
      expect(
        await page.getByRole("button", { name: "Start session", exact: true }).isDisabled(),
      ).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(page.url()).toBe(originalUrl);
    } finally {
      await browser.close();
    }
  });

  it.each([false, true])(
    "keeps late rejected first-turn attachments retryable (storage failure: %s)",
    async (storageFailure) => {
      const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      try {
        const page = await browser.newPage();
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
      } finally {
        await browser.close();
      }
    },
  );

  it("retries navigation without recreating an already admitted session", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main#navigation-error`);
      await page.locator(".new-session-page__message").fill("create this session only once");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const params = createParams(await gateway.waitForRequest("sessions.create"));
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
      await gateway.resolveDeferred("sessions.create", { key: params.key });
      await expect
        .poll(() => page.locator("openclaw-new-session-page").textContent())
        .toContain("Synthetic committed route failed");
      await captureUiProof(suite, page, "submitted-prompt-after-navigation-failure.png");
      await expect
        .poll(() => page.locator(".new-session-page__starting").textContent())
        .toContain("create this session only once");
      await page.getByRole("button", { name: "Open session", exact: true }).click();
      await waitForCommittedChatRoute(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(String(params.key)));
    } finally {
      await browser.close();
    }
  });

  it("keeps the existing draft flow when the Gateway has no authenticated recovery scope", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
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
    } finally {
      await browser.close();
    }
  });
  it("adopts a confirmed create even when transient preview readiness fails", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await browser.newPage();
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator(".new-session-page__message").fill("keep the confirmed creation");
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
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const params = createParams(await gateway.waitForRequest("sessions.create"));
      await gateway.resolveDeferred("sessions.create", { key: params.key });
      await waitForCommittedChatRoute(page);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(String(params.key)));
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
});
