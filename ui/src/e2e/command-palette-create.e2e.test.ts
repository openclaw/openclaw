import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { twoFrames } from "./chat-presentation.test-support.ts";
import {
  expectPaletteProjectGrouping,
  expectPaletteSettingsAlignment,
} from "./command-palette-settings.test-support.ts";
import {
  foregroundDraft,
  scenario,
  openFromForeground,
  expectForegroundUnchanged,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { controlUiSessionPath, installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "command palette background creation",
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});
async function changePicker(
  picker: Locator,
  eventType: "overlay-after-show" | "overlay-after-hide",
  action: () => Promise<void>,
) {
  await Promise.all([
    picker.evaluate(
      (element, type) =>
        new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            element.removeEventListener(type, settled);
            reject(new Error(`Missing ${type} from ${element.className}`));
          }, 10_000);
          const settled = (event: Event) => {
            if (event.target !== element) {
              return;
            }
            window.clearTimeout(timer);
            element.removeEventListener(type, settled);
            resolve();
          };
          element.addEventListener(type, settled);
        }),
      eventType,
    ),
    action(),
  ]);
}

suite.define(() => {
  it.each([
    { width: 1280, colorScheme: "dark", reducedMotion: "no-preference" },
    { width: 390, colorScheme: "light", reducedMotion: "reduce" },
  ] as const)(
    "collapses prompt searches in place and restores them at $width px",
    async (options) => {
      await suite.withPage(
        {
          colorScheme: options.colorScheme,
          reducedMotion: options.reducedMotion,
          viewport: { width: options.width, height: 900 },
        },
        async ({ page }) => {
          await installMockGateway(
            page,
            scenario({ "models.list": { models: [], refreshFailed: true } }),
          );
          const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
          await input.fill("appearance");
          await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
          await expect
            .poll(() => palette.locator(".cmd-palette__results").getAttribute("aria-busy"))
            .toBe("false");
          expect(await palette.locator(".cmd-palette__source-error").count()).toBe(0);
          const search = palette.locator(".cmd-palette__search");
          const original = (await palette.locator(".cmd-palette").boundingBox())!;
          const inputTop = (await input.boundingBox())!.y;
          const initialHeight = (await search.boundingBox())!.height;
          const prompt = "Help me plan the next steps for this small project this week";
          const samples = await input.evaluateHandle((element: HTMLTextAreaElement, value) => {
            const frames: Array<{
              x: number;
              y: number;
              width: number;
              inputY: number;
              searchHeight: number;
            }> = [];
            const start = performance.now();
            const sample = () => {
              const bounds = element.closest(".cmd-palette")!.getBoundingClientRect();
              frames.push({
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                inputY: element.getBoundingClientRect().y,
                searchHeight: element
                  .closest(".cmd-palette")!
                  .querySelector(".cmd-palette__search")!
                  .getBoundingClientRect().height,
              });
              if (performance.now() - start < 400) {
                requestAnimationFrame(sample);
              }
            };
            requestAnimationFrame(sample);
            element.value = value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return frames;
          }, prompt);
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(true);
          await expect.poll(async () => (await search.boundingBox())?.height).toBe(0);
          await page.waitForTimeout(450);
          const frames = await samples.jsonValue();
          await samples.dispose();
          expect(frames.length).toBeGreaterThan(1);
          for (const frame of frames) {
            expect(frame.x).toBeCloseTo(original.x, 1);
            expect(frame.y).toBeCloseTo(original.y, 1);
            expect(frame.width).toBeCloseTo(original.width, 1);
            expect(frame.inputY).toBeCloseTo(inputTop, 1);
          }
          if (options.reducedMotion === "no-preference") {
            expect(
              frames.some(
                (frame) => frame.searchHeight > 0 && frame.searchHeight < initialHeight - 1,
              ),
            ).toBe(true);
          } else {
            expect(
              await search.evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).transitionDuration),
              ),
            ).toBeLessThanOrEqual(0.00001);
          }
          await input.fill("");
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(false);
          await palette.getByRole("option", { name: "New session", exact: true }).waitFor();
          expect((await palette.locator(".cmd-palette").boundingBox())!.y).toBe(original.y);
        },
      );
    },
  );

  it.each([
    { mode: "dark", width: 1280 },
    { mode: "light", width: 390 },
  ] as const)(
    "aligns settings and preserves keyboard focus in $mode at $width",
    async ({ mode, width }) => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          colorScheme: mode,
          viewport: { width, height: 900 },
          deviceScaleFactor: 2,
        },
        async ({ page }) => {
          await installMockGateway(page, scenario());
          const { palette } = await openFromForeground(page, suite.server.baseUrl);
          const popup = palette.locator(".oc-popover.palette-session-settings");
          await changePicker(popup, "overlay-after-show", () =>
            palette.getByRole("button", { name: "New session settings", exact: true }).click(),
          );
          await expectPaletteSettingsAlignment(popup);
          const remember = popup.getByRole("checkbox", { name: /Remember settings for/ });
          expect(await remember.isVisible()).toBe(true);
          const workspaceButton = popup.locator(".palette-session-settings__workspace");
          const search = popup.getByRole("searchbox", { name: "Search", exact: true });
          const searchToggle = popup.locator(".header-search__toggle");
          await workspaceButton.click();
          await searchToggle.waitFor({ state: "visible" });
          await expectPaletteProjectGrouping(popup);
          expect.soft(await remember.count()).toBe(0);
          // Pointer entry keeps focus inside the nested view without summoning a
          // text caret (or a touch keyboard). Tab still reaches its search control.
          await page.keyboard.press("Tab");
          expect
            .soft(await searchToggle.evaluate((element) => document.activeElement === element))
            .toBe(true);
          await page.keyboard.press("Escape");
          expect(await remember.isVisible()).toBe(true);
          expect(
            await workspaceButton.evaluate((element) => document.activeElement === element),
          ).toBe(true);
          await workspaceButton.press("Enter");
          await searchToggle.waitFor({ state: "visible" });
          expect(await searchToggle.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
          await page.keyboard.type("no-such-workspace");
          await search.waitFor({ state: "visible" });
          expect(await search.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await popup.locator("[data-machine]").count()).toBe(0);
          await popup.getByRole("button", { name: "Back", exact: true }).click();
          expect(await remember.isVisible()).toBe(true);
          await workspaceButton.press("Enter");
          expect(await search.count()).toBe(0);
          await popup.locator('[data-machine="local"][data-project=""]').click();
          expect(await remember.isVisible()).toBe(true);
        },
      );
    },
  );

  it.each([
    { destination: "local", width: 1280 },
    { destination: "device", width: 390 },
  ] as const)(
    "starts one $destination task without replacing the foreground draft at $width px",
    async ({ destination, width }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const sessionKey = "agent:reviewer:dashboard:palette-created-" + destination;
          const gateway = await installMockGateway(
            page,
            scenario({
              "sessions.create": {
                key: sessionKey,
                entry: { sessionId: "session:" + sessionKey },
                ...(destination === "local"
                  ? { runStarted: true, runId: "palette-local-run" }
                  : {}),
              },
              "sessions.dispatch": {
                ok: true,
                key: sessionKey,
                sessionId: "session:" + sessionKey,
                placement: { state: "active", generation: 1 },
              },
              "chat.send": { runId: "palette-device-run", status: "started" },
            }),
          );
          const { composer, url, palette, input } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          const prompt = "Investigate missing worker error messages.\n".repeat(6).trimEnd();
          const finalLine = "Keep the changes focused.";
          const emptySearch = { ts: 1, path: "", defaults: {}, count: 0, sessions: [] };
          await gateway.setMethodResponse("sessions.list", {
            cases: [
              { match: { search: prompt }, response: emptySearch },
              { match: { search: prompt + "\n" + finalLine }, response: emptySearch },
            ],
          });
          await input.fill(prompt);
          const searchPanel = palette.locator(".cmd-palette__search");
          await expect
            .poll(() => searchPanel.evaluate((element: HTMLElement) => element.inert))
            .toBe(true);
          await expect.poll(async () => (await searchPanel.boundingBox())?.height).toBe(0);
          expect(await palette.getByRole("option").count()).toBe(0);
          await input.press("Enter");
          expect(await input.inputValue()).toBe(prompt);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          await input.press("Shift+Enter");
          await input.pressSequentially(finalLine);
          const submittedPrompt = prompt + "\n" + finalLine;
          expect(await input.inputValue()).toBe(submittedPrompt);
          expect(await input.getAttribute("aria-controls")).toBeNull();
          expect(
            (await gateway.getRequests("sessions.search")).filter(
              (request) => isRecord(request.params) && request.params.query === submittedPrompt,
            ),
          ).toEqual([]);

          const settings = palette.locator(".oc-popover.palette-session-settings");
          await changePicker(settings, "overlay-after-show", () =>
            palette.getByRole("button", { name: "New session settings", exact: true }).click(),
          );
          const agent = palette.locator("openclaw-agent-select");
          await changePicker(agent.locator(".agent-select__menu"), "overlay-after-show", () =>
            agent.getByRole("button", { name: /^Agent:/ }).click(),
          );
          const reviewer = agent.getByRole("option", { name: "Reviewer", exact: true });
          await reviewer.waitFor();
          await agent.getByRole("listbox").press("End");
          await expect
            .poll(() =>
              reviewer.evaluate(
                (element) =>
                  document.activeElement?.getAttribute("aria-activedescendant") === element.id,
              ),
            )
            .toBe(true);
          await page.keyboard.press("Enter");
          await expect
            .poll(() => agent.getByRole("button", { name: /^Agent:/ }).textContent())
            .toContain("Reviewer");
          expect(await input.isVisible()).toBe(true);
          expect(page.url()).toBe(url);

          if (destination === "local") {
            const worktree = settings.getByRole("switch", { name: "New worktree", exact: true });
            if ((await worktree.getAttribute("aria-checked")) !== "true") {
              await worktree.click();
            }
          }
          if (destination === "device") {
            await gateway.waitForRequest("environments.list");
            const workspaceChoice = settings.locator(".palette-session-settings__workspace");
            await workspaceChoice.click();
            await settings.locator(".header-search__toggle").click();
            const search = settings.getByRole("searchbox");
            await search.fill("Palette runner");
            await search.press("Escape");
            await page.keyboard.press("Escape");
            await workspaceChoice.waitFor({ state: "visible" });
            expect(await input.isVisible()).toBe(true);
            await workspaceChoice.press("Enter");
            const runner = settings.locator(
              '[data-machine="device:palette-runner"][data-project=""]',
            );
            await runner.waitFor();
            await runner.focus();
            await runner.press("Enter");
            await expect.poll(() => workspaceChoice.textContent()).toContain("Palette runner");
          }
          await changePicker(settings, "overlay-after-hide", () =>
            settings.locator(".palette-session-settings__workspace").press("Escape"),
          );
          const start = palette.getByRole("button", {
            name: "Start new session in background",
            exact: true,
          });
          await expect.poll(() => start.isEnabled()).toBe(true);
          expect(await palette.locator(".agent-chat__composer-shell").count()).toBe(0);
          expect(await palette.locator(".chat-composer-model-control").count()).toBe(0);
          expect(await palette.locator(".new-session-page__visibility").count()).toBe(0);
          const bounds = (await palette.locator(".cmd-palette").boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
          await input.focus();
          await gateway.deferNext("sessions.create");
          await gateway.deferNext("agent.wait");
          await input.press("ControlOrMeta+Enter");
          const create = await gateway.waitForRequest("sessions.create");
          expect(create.params).toMatchObject({
            agentId: "reviewer",
            message: destination === "device" ? "" : submittedPrompt,
            worktree: true,
            ...(destination === "device" ? { worktreeSource: "empty" } : {}),
          });
          expect(create.params).not.toHaveProperty("execNode");
          expect(create.params).not.toHaveProperty("parentSessionKey");
          // Optimistic start: the launcher returns to the foreground before admission.
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
          // Reopening shows the pending start; a second chord must not start a second session.
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          expect(await input.inputValue()).toBe(submittedPrompt);
          await expect.poll(() => start.isEnabled()).toBe(false);
          await input.press("ControlOrMeta+Enter");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          await gateway.resolveDeferred("sessions.create");
          expect(page.url()).toBe(url);
          if (destination === "device") {
            expect((await gateway.waitForRequest("sessions.dispatch")).params).toEqual({
              key: sessionKey,
              agentId: "reviewer",
              deviceId: "palette-runner",
            });
            expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
              sessionKey,
              sessionId: "session:" + sessionKey,
              expectedLeafEntryId: null,
              message: submittedPrompt,
            });
          }
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(
            destination === "device" ? 1 : 0,
          );
          await page
            .locator(".app-toast")
            .getByRole("button", { name: "Open session", exact: true })
            .waitFor();
        },
      );
    },
  );

  it("opens persistent rejected-turn recovery with the keyboard after dismissing its toast", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const key = "agent:main:dashboard:palette-rejected-turn";
      const gateway = await installMockGateway(
        page,
        scenario({
          "sessions.create": {
            key,
            runError: { code: "INVALID_REQUEST", message: "Initial turn rejected" },
          },
        }),
      );
      const { composer, url, palette, input } = await openFromForeground(
        page,
        suite.server.baseUrl,
      );
      const prompt = "Keep this accepted session recoverable.\nDo not send the same request twice.";
      await input.fill(prompt);
      const start = palette.getByRole("button", {
        name: "Start new session in background",
        exact: true,
      });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await input.press("ControlOrMeta+Enter");
      await gateway.waitForRequest("sessions.create");
      await input.waitFor({ state: "hidden" });
      const toast = page.locator(".app-toast");
      await expect.poll(() => toast.textContent()).toContain("Initial turn rejected");
      await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
      await toast.waitFor({ state: "hidden" });
      expect(page.url()).toBe(url);
      expect(await composer.inputValue()).toBe(foregroundDraft);
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      await expect
        .poll(() => palette.getByRole("alert").textContent())
        .toContain("Initial turn rejected");
      expect(await input.inputValue()).toBe(prompt);
      await input.press("ControlOrMeta+Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      const recovery = palette.getByRole("button", { name: "Open session", exact: true });
      await recovery.waitFor({ state: "visible" });
      await input.focus();
      for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press("Tab");
        if (await recovery.evaluate((element) => document.activeElement === element)) {
          break;
        }
      }
      expect(await recovery.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
      await input.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });

  it("keeps a rejected creation visible and retries the same prompt without touching chat", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        scenario({
          "sessions.create": { key: "agent:main:dashboard:palette-retried", runStarted: true },
        }),
      );
      const { composer, url, palette, input } = await openFromForeground(
        page,
        suite.server.baseUrl,
      );
      const prompt = "Preserve this task when creation is denied.\nRetry only after I ask.";
      await input.fill(prompt);
      const start = palette.getByRole("button", {
        name: "Start new session in background",
        exact: true,
      });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await gateway.deferNext("sessions.create");
      await input.press("ControlOrMeta+Enter");
      await gateway.waitForRequest("sessions.create");
      await input.waitFor({ state: "hidden" });
      // Reopened while pending, the prompt stays focused and read-only.
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      await expect.poll(() => start.isEnabled()).toBe(false);
      await twoFrames(page);
      expect(
        await input.evaluate((element: HTMLTextAreaElement) => [
          document.activeElement === element,
          element.readOnly,
          element.getAttribute("aria-busy"),
        ]),
      ).toEqual([true, true, "true"]);
      await input.press("Escape");
      await input.waitFor({ state: "hidden" });
      await gateway.rejectDeferred("sessions.create", {
        code: "INVALID_REQUEST",
        message: "Fixture denied creation; correct the request and retry.",
      });
      const toast = page.locator(".app-toast");
      await expect.poll(() => toast.textContent()).toContain("Session didn't start");
      await toast.getByRole("button", { name: "Edit prompt", exact: true }).click();
      await input.waitFor({ state: "visible" });
      const error = palette.getByRole("alert");
      await expect.poll(() => error.textContent()).toContain("Fixture denied creation");
      expect(await input.inputValue()).toBe(prompt);
      expect(page.url()).toBe(url);
      expect(await composer.inputValue()).toBe(foregroundDraft);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      await expect
        .poll(() => input.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(await input.getAttribute("aria-busy")).toBeNull();
      await expect.poll(() => start.isEnabled()).toBe(true);
      await input.press("ControlOrMeta+Enter");
      const retry = await gateway.waitForRequest("sessions.create", { after: 1 });
      expect(retry.params).toMatchObject({ agentId: "main", message: prompt });
      await input.waitFor({ state: "hidden" });
      await expectForegroundUnchanged(page, composer, url);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });
});
