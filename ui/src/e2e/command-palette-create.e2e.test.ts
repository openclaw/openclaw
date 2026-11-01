import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { captureUiProof } from "./chat-flow.test-support.ts";
import { twoFrames } from "./chat-presentation.test-support.ts";
import {
  expectPaletteChipsAligned,
  expectPaletteProjectGrouping,
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
    "switches Search and Compose in place and remembers the chosen mode at $width px",
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
          await captureUiProof(suite, page, "cmdk-modes", `search-${options.width}.png`);
          const samples = await input.evaluateHandle((element: HTMLTextAreaElement) => {
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
            element.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
            );
            return frames;
          });
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
          // The card swaps content in one frame: an in-between height would read as jitter.
          for (const frame of frames) {
            expect(
              frame.searchHeight === 0 || Math.abs(frame.searchHeight - initialHeight) < 1,
            ).toBe(true);
          }
          await captureUiProof(suite, page, "cmdk-modes", `compose-${options.width}.png`);
          expect(await input.inputValue()).toBe("appearance");
          await input.press("Escape");
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              palette
                .getByRole("tab", { name: "Compose", exact: true })
                .getAttribute("aria-selected"),
            )
            .toBe("true");
          const composeTab = palette.getByRole("tab", { name: "Compose", exact: true });
          await composeTab.focus();
          await composeTab.press("ArrowLeft");
          const searchTab = palette.getByRole("tab", { name: "Search", exact: true });
          await expect.poll(() => searchTab.getAttribute("aria-selected")).toBe("true");
          expect(await searchTab.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
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
    "aligns the chips and preserves keyboard focus in $mode at $width",
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
          const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
          await input.press("Tab");
          await expectPaletteChipsAligned(palette);
          const popup = palette.locator(".oc-popover.palette-session-settings");
          const folder = palette.locator(".palette-session-settings__trigger");
          await changePicker(popup, "overlay-after-show", () => folder.click());
          const remember = popup.getByRole("checkbox", { name: /Remember settings for/ });
          expect(await remember.isVisible()).toBe(true);
          const search = popup.getByRole("searchbox", { name: "Search", exact: true });
          const searchToggle = popup.locator(".header-search__toggle");
          await searchToggle.waitFor({ state: "visible" });
          await expectPaletteProjectGrouping(popup);
          await changePicker(popup, "overlay-after-hide", () => page.keyboard.press("Escape"));
          expect(await folder.evaluate((element) => document.activeElement === element)).toBe(true);
          await changePicker(popup, "overlay-after-show", () => folder.press("Enter"));
          await searchToggle.focus();
          await searchToggle.press("Enter");
          await search.waitFor({ state: "visible" });
          await page.keyboard.type("no-such-workspace");
          expect(await search.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await popup.locator("[data-machine]").count()).toBe(0);
          await search.fill("");
          await changePicker(popup, "overlay-after-hide", () =>
            popup.locator('[data-machine="local"][data-project=""]').click(),
          );
          expect(await folder.evaluate((element) => document.activeElement === element)).toBe(true);
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
          await input.press("Tab");
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
            const worktree = palette.getByRole("switch", { name: "New worktree", exact: true });
            if ((await worktree.getAttribute("aria-checked")) !== "true") {
              await worktree.click();
            }
          }
          if (destination === "device") {
            await gateway.waitForRequest("environments.list");
            const workspaceChoice = palette.locator(".palette-session-settings__trigger");
            await changePicker(settings, "overlay-after-show", () => workspaceChoice.click());
            await settings.locator(".header-search__toggle").click();
            const search = settings.getByRole("searchbox");
            await search.fill("Palette runner");
            await search.press("Escape");
            await changePicker(settings, "overlay-after-hide", () => page.keyboard.press("Escape"));
            expect(await input.isVisible()).toBe(true);
            await changePicker(settings, "overlay-after-show", () =>
              workspaceChoice.press("Enter"),
            );
            const runner = settings.locator(
              '[data-machine="device:palette-runner"][data-project=""]',
            );
            await runner.waitFor();
            await runner.focus();
            await runner.press("Enter");
            await expect
              .poll(() => workspaceChoice.getAttribute("aria-label"))
              .toContain("Palette runner");
          }
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
          await expect.poll(() => start.isEnabled()).toBe(false);
          // A second physical chord while admission is pending must not start a second session.
          await page.keyboard.press("ControlOrMeta+Enter");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          expect(page.url()).toBe(url);
          await gateway.resolveDeferred("sessions.create");
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
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
      await input.press("Tab");
      const prompt = "Keep this accepted session recoverable.\nDo not send the same request twice.";
      await input.fill(prompt);
      const start = palette.getByRole("button", {
        name: "Start new session in background",
        exact: true,
      });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await input.press("ControlOrMeta+Enter");
      await gateway.waitForRequest("sessions.create");
      await expect
        .poll(() => palette.getByRole("alert").textContent())
        .toContain("Initial turn rejected");
      const toast = page.locator(".app-toast");
      await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
      await toast.waitFor({ state: "hidden" });
      expect(await input.inputValue()).toBe(prompt);
      expect(page.url()).toBe(url);
      expect(await composer.inputValue()).toBe(foregroundDraft);
      await input.press("ControlOrMeta+Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      const recovery = palette.getByRole("button", { name: "Open session", exact: true });
      await recovery.waitFor({ state: "visible" });
      await input.focus();
      for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press("Shift+Tab");
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
      await input.press("Tab");
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
      // A disabled field loses focus on the next frame; the pending prompt stays focused and read-only.
      await expect.poll(() => start.isEnabled()).toBe(false);
      await twoFrames(page);
      expect(
        await input.evaluate((element: HTMLTextAreaElement) => [
          document.activeElement === element,
          element.readOnly,
          element.getAttribute("aria-busy"),
        ]),
      ).toEqual([true, true, "true"]);
      await gateway.rejectDeferred("sessions.create", {
        code: "INVALID_REQUEST",
        message: "Fixture denied creation; correct the request and retry.",
      });
      const error = palette.getByRole("alert");
      await expect.poll(() => error.textContent()).toContain("Fixture denied creation");
      expect(await input.inputValue()).toBe(prompt);
      expect(page.url()).toBe(url);
      expect(await composer.inputValue()).toBe(foregroundDraft);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
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
