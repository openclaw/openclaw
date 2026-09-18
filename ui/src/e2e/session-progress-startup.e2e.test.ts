import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const startupCases = [
  ...[
    { name: "empty", steps: 0, collapsed: false },
    { name: "collapsed one item", steps: 1, collapsed: true },
    { name: "expanded one item", steps: 1, collapsed: false },
    { name: "collapsed long checklist", steps: 18, collapsed: true },
    { name: "expanded long checklist", steps: 18, collapsed: false },
  ].flatMap(({ name, steps, collapsed }) =>
    [120, 800].map((latency) => ({ name, steps, collapsed, latency, outcome: "success" })),
  ),
  ...["error", "never"].map((outcome) => ({
    name: outcome,
    steps: 0,
    collapsed: false,
    latency: 800,
    outcome,
  })),
];

suite.define(() => {
  it.each(startupCases)(
    "paints history before $name progress after $latency ms and mounts late cards closed",
    async (scenario) => {
      const context = await suite.newBrowserContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "no-preference",
      });
      await context.addInitScript(
        ({ gatewayUrl, settingsKey, collapsed }) => {
          localStorage.setItem(
            settingsKey,
            JSON.stringify({ gatewayUrl, chatCollapseTaskProgress: collapsed }),
          );
        },
        {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          collapsed: scenario.collapsed,
        },
      );
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const card =
        scenario.steps > 0
          ? {
              sessionKey,
              revision: 1,
              updatedAt: 1,
              steps: Array.from({ length: scenario.steps }, (_, index) => ({
                step: `Checklist item ${index + 1}: inspect the conversation and verify its result`,
                status: index === 0 ? "in_progress" : "pending",
              })),
            }
          : null;
      const gateway = await installMockGateway(page, {
        sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1, hasActiveRun: false },
        historyMessages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: "text",
              text:
                index === 39
                  ? "Ready."
                  : `Conversation message ${index + 1}. A synthetic historical turn.`,
            },
          ],
        })),
        deferredMethods: ["chat.startup", "progressCard.get", "chat.send"],
        methodResponses: { "progressCard.get": { card } },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Queue before history and progress");
        const textarea = await composer.elementHandle();
        expect(textarea).not.toBeNull();
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "startup-note.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic startup attachment"),
        });
        await page.locator(".chat-attachment-thumb", { hasText: "startup-note.txt" }).waitFor();
        await composer.press("Enter");
        await page
          .locator(".chat-queue")
          .getByText("Queue before history and progress", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        const draft = "Keep this draft while progress loads";
        await composer.fill(draft);
        await gateway.resolveDeferred("chat.startup");
        await gateway.waitForRequest("progressCard.get");
        const send = await gateway.waitForRequest("chat.send");
        expect(send.params).toMatchObject({
          sessionKey,
          message: "Queue before history and progress",
          attachments: [expect.objectContaining({ fileName: "startup-note.txt" })],
        });
        const ready = page.locator(".chat-thread").getByText("Ready.", { exact: true });
        await ready.waitFor();
        expect(await page.locator(".session-progress-card--composer").count()).toBe(0);
        const paintedDisclosure = await page.evaluateHandle(() => {
          const frames: boolean[] = [];
          let frame = 0;
          const sample = () => {
            const element = document.querySelector<HTMLDetailsElement>(
              ".session-progress-card--composer",
            );
            if (element?.checkVisibility({ visibilityProperty: true })) {
              frames.push(element.open);
            }
            frame = requestAnimationFrame(sample);
          };
          frame = requestAnimationFrame(sample);
          return { frames, cancel: () => cancelAnimationFrame(frame) };
        });
        try {
          // History is already visible throughout the unresolved RPC, including
          // the case that never answers. The delay is fixture latency, not a retry.
          await page.waitForTimeout(scenario.latency);
          expect(await ready.isVisible()).toBe(true);
          if (scenario.outcome === "error") {
            await gateway.rejectDeferred("progressCard.get", {
              message: "Progress temporarily unavailable",
            });
          } else if (scenario.outcome === "success") {
            await gateway.resolveDeferred("progressCard.get", { card });
          }
          const progress = page.locator(".session-progress-card--composer");
          if (card) {
            await progress.waitFor();
            await expect
              .poll(() => paintedDisclosure.evaluate((capture) => capture.frames.length))
              .toBeGreaterThanOrEqual(3);
            expect(
              await paintedDisclosure.evaluate((capture) => capture.frames.some(Boolean)),
            ).toBe(false);
            expect(await progress.getAttribute("open")).toBe(null);
          } else {
            expect(await progress.count()).toBe(0);
          }
          expect(await ready.isVisible()).toBe(true);
          expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(
            true,
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        } finally {
          await paintedDisclosure.evaluate((capture) => capture.cancel());
          await paintedDisclosure.dispose();
        }
        if (scenario.outcome === "never") {
          return;
        }

        const progress = page.locator(".session-progress-card--composer");
        if (card) {
          await progress.locator("summary").click();
          await expect.poll(() => progress.getAttribute("open")).toBe("");
        }
        const mountedCard = card ? await progress.elementHandle() : null;
        const disclosure = card ? await progress.getAttribute("open") : null;
        await composer.fill("Keep this draft while progress refreshes");
        await gateway.deferNext("progressCard.get");
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBe(2);
        if (card) {
          expect(await progress.getAttribute("open")).toBe(disclosure);
          expect(await progress.evaluate((node, original) => node === original, mountedCard)).toBe(
            true,
          );
        }
        await gateway.rejectDeferred("progressCard.get", {
          message: "Refresh temporarily unavailable",
        });
        // Allow the rejection and following paint to commit before checking retention.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep this draft while progress refreshes");
        expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(
          await page.locator(".chat-thread").getByText("Ready.", { exact: true }).isVisible(),
        ).toBe(true);
        if (card) {
          expect(await progress.evaluate((node, original) => node === original, mountedCard)).toBe(
            true,
          );
          expect(await progress.getAttribute("open")).toBe(disclosure);
          expect(await progress.locator(".session-progress-card__step").count()).toBe(
            scenario.steps,
          );
          // A disappearing card remounts through the real store. Its late default
          // must not replace the user's explicit per-session expanded choice.
          for (const revision of [3, 4]) {
            const requests = (await gateway.getRequests("progressCard.get")).length;
            await gateway.deferNext("progressCard.get");
            await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision });
            await gateway.waitForRequest("progressCard.get", { after: requests });
            await gateway.resolveDeferred("progressCard.get", {
              card: revision === 3 ? null : { ...card, revision },
            });
            if (revision === 3) {
              await progress.waitFor({ state: "detached" });
            } else {
              await progress.waitFor();
              expect(await progress.getAttribute("open")).toBe("");
            }
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["unavailable", "access-denied"] as const)(
    "mounts the first recovered card closed after an initial %s response",
    async (failure) => {
      const context = await suite.newBrowserContext({});
      await context.addInitScript(
        ({ gatewayUrl, settingsKey }) => {
          localStorage.setItem(
            settingsKey,
            JSON.stringify({ gatewayUrl, chatCollapseTaskProgress: false }),
          );
        },
        {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        },
      );
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1, hasActiveRun: false },
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        deferredMethods: ["progressCard.get"],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        const ready = page.locator(".chat-thread").getByText("Ready.", { exact: true });
        await ready.waitFor();
        await gateway.rejectDeferred("progressCard.get", {
          code: failure === "access-denied" ? "INVALID_REQUEST" : "UNAVAILABLE",
          message: "Progress temporarily unavailable",
          ...(failure === "access-denied"
            ? { details: { code: "SESSION_PARTICIPATION_REQUIRED" } }
            : {}),
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const progress = page.locator(".session-progress-card--composer");
        expect(await ready.isVisible()).toBe(true);
        expect(await progress.count()).toBe(0);
        const requests = (await gateway.getRequests("progressCard.get")).length;
        await gateway.deferNext("progressCard.get");
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await gateway.waitForRequest("progressCard.get", { after: requests });
        // A composer update while the retry is pending must not treat a denied
        // read's cached null as a successful first progress response.
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this recovery draft");
        await gateway.resolveDeferred("progressCard.get", {
          card: {
            sessionKey,
            revision: 2,
            updatedAt: 2,
            steps: [{ step: "Recovered progress", status: "in_progress" }],
          },
        });
        await progress.waitFor();
        expect(await progress.getAttribute("open")).toBe(null);
        expect(await composer.inputValue()).toBe("Keep this recovery draft");
        expect(await ready.isVisible()).toBe(true);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["history", "progress"] as const)(
    "paints history before progress and preserves the composer when %s settles first during refresh",
    async (first) => {
      const context = await suite.newBrowserContext({});
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1 },
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        deferredMethods: ["progressCard.get"],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const draft = "Keep draft and focus through either reply order";
        await composer.fill(draft);
        const textarea = await composer.elementHandle();
        expect(textarea).not.toBeNull();
        // Initial history owns progress admission. A live message can independently
        // refresh that history while the first progress response is still pending.
        await gateway.deferNext("chat.history");
        const before = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          messageId: "startup-peer-message",
          messageSeq: 3,
          message: {
            role: "user",
            content: [{ type: "text", text: "A peer joined the conversation." }],
            __openclaw: { id: "startup-peer-message", seq: 3 },
          },
        });
        await gateway.waitForRequest("chat.history", { after: before });
        for (const response of [first, first === "history" ? "progress" : "history"]) {
          if (response === "history") {
            await gateway.resolveDeferred("chat.history");
          } else {
            await gateway.resolveDeferred("progressCard.get", {
              card: { sessionKey, revision: 1, updatedAt: 1, markdown: "Initial task progress" },
            });
            await page.locator(".session-progress-card--composer").waitFor();
          }
          expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(
            true,
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the normal disclosure when progress arrives before retried history", async () => {
    const context = await suite.newBrowserContext({});
    await context.addInitScript(
      ({ gatewayUrl, settingsKey }) => {
        localStorage.setItem(
          settingsKey,
          JSON.stringify({ gatewayUrl, chatCollapseTaskProgress: false }),
        );
      },
      {
        gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
        settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      },
    );
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const card = {
      sessionKey,
      revision: 1,
      updatedAt: 1,
      steps: [{ step: "Inspect the recovered task", status: "in_progress" }],
    };
    const gateway = await installMockGateway(page, {
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      deferredMethods: ["chat.startup", "progressCard.get"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", { message: "History temporarily unavailable" });
      await page.locator('.chat-history-error[role="alert"]').waitFor();
      await gateway.waitForRequest("progressCard.get");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await gateway.resolveDeferred("progressCard.get", { card });
      const progress = page.locator(".session-progress-card--composer");
      await progress.waitFor();
      // The error screen has not presented a transcript yet.
      expect(await progress.getAttribute("open")).toBe("");
      await page
        .locator('.chat-history-error[role="alert"]')
        .getByRole("button", { name: "Retry" })
        .click();
      await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
      expect(await progress.getAttribute("open")).toBe("");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows retried history while progress remains pending without replacing the composer", async () => {
    const context = await suite.newBrowserContext({});
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      deferredMethods: ["chat.startup", "progressCard.get"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", { message: "History temporarily unavailable" });
      const error = page.locator('.chat-history-error[role="alert"]');
      await error.waitFor();
      expect(await error.textContent()).toContain("History temporarily unavailable");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft = "Preserve this recovery draft";
      await composer.fill(draft);
      const textarea = await composer.elementHandle();
      expect(textarea).not.toBeNull();
      await gateway.waitForRequest("progressCard.get");
      const startupRequests = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await error.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("chat.startup", { after: startupRequests });
      await gateway.resolveDeferred("chat.startup");
      await error.waitFor({ state: "detached" });
      await composer.focus();
      // Progress is still deferred: a successful history retry must paint without it.
      await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
      expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
      expect(await composer.inputValue()).toBe(draft);
      await gateway.resolveDeferred("progressCard.get", {
        card: {
          sessionKey: "agent:main:main",
          revision: 1,
          updatedAt: 1,
          markdown: "Recovered task progress",
        },
      });
      await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
      await page.locator(".session-progress-card--composer").waitFor();
      expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
      expect(await composer.inputValue()).toBe(draft);
      expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
