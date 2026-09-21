import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  appearanceKey,
  foregroundKey,
  foregroundDraft,
  scenario,
  openFromForeground,
  expectForegroundUnchanged,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "command palette background creation",
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});
async function changePicker(
  picker: Locator,
  eventType: "wa-after-show" | "wa-after-hide",
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

function captureAfter(page: Page, name: string) {
  const directory =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
      ? createControlUiE2eArtifactDir(name, suite.artifactDir)
      : undefined;
  return async (stage: string) => {
    if (directory) {
      const palette = page.locator(".cmd-palette");
      const options = {
        path: path.join(directory, stage + ".png"),
        animations: "disabled" as const,
      };
      if (await palette.isVisible()) {
        await palette.screenshot(options);
      } else {
        await page.screenshot(options);
      }
    }
  };
}

suite.define(() => {
  it("preserves manual prompt scrolling when background destination discovery finishes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...scenario(),
        deferredMethods: ["environments.list"],
      });
      const { composer, url, palette, input } = await openFromForeground(
        page,
        suite.server.baseUrl,
      );
      await gateway.waitForRequest("environments.list");
      const capture = captureAfter(page, "palette-manual-scroll");
      const prompt = [
        "FIRST WORDS: Review the complete task before starting.",
        "Keep the foreground conversation unchanged.",
        "Read the existing behavior and identify its owner.",
        "Compare related paths before choosing a repair.",
        "Keep the fix focused on the reported behavior.",
        "Add a regression test that fails before the fix.",
        "Verify the repaired behavior in the browser.",
        "LAST WORDS: Open a pull request with the evidence.",
      ].join("\n");
      await input.fill(prompt);
      const search = palette.locator(".cmd-palette__search");
      await expect.poll(() => search.evaluate((element: HTMLElement) => element.inert)).toBe(true);
      expect(await gateway.getRequests("sessions.search")).toEqual([]);
      await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await input.hover();
      await page.mouse.wheel(0, -2000);
      await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionEnd)).toBe(
        prompt.length,
      );
      await capture("scrolled-to-first-words");

      // Prompt mode pauses search, but destination discovery still updates the
      // real draft controller and rerenders its input without an edit.
      await gateway.resolveDeferred("environments.list");
      // Let the render's layout frame and ResizeObserver delivery finish.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await capture("after-background-discovery");
      expect(await input.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await input.inputValue()).toBe(prompt);
      expect(await composer.inputValue()).toBe(foregroundDraft);
      expect(page.url()).toBe(url);
      expect(await gateway.getRequests("sessions.create")).toEqual([]);

      await input.pressSequentially(" Continue.");
      await expect
        .poll(() =>
          input.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      expect(await input.inputValue()).toBe(prompt + " Continue.");
    });
  });

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
          const gateway = await installMockGateway(
            page,
            scenario({ "models.list": { models: [], refreshFailed: true } }),
          );
          const { palette, input, composer, url } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          await input.fill("appearance");
          await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
          await palette
            .locator(".cmd-palette__search")
            .getByRole("status")
            .filter({ hasText: "Models unavailable" })
            .waitFor();
          const search = palette.locator(".cmd-palette__search");
          const original = (await palette.locator(".cmd-palette").boundingBox())!;
          const inputTop = (await input.boundingBox())!.y;
          const initialHeight = (await search.boundingBox())!.height;
          const requestCount = (await gateway.getRequests("sessions.search")).length;
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
          expect(await palette.getByRole("group", { name: "Filter search results" }).count()).toBe(
            0,
          );
          expect(await palette.locator(".cmd-palette__search").getByRole("status").count()).toBe(0);
          expect(await palette.getByRole("option").count()).toBe(0);
          expect(await input.getAttribute("aria-controls")).toBeNull();
          expect(await input.getAttribute("aria-activedescendant")).toBeNull();
          expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
          await input.press("ArrowDown");
          await input.press("Enter");
          expect(await input.inputValue()).toBe(prompt);
          expect(page.url()).toBe(url);
          expect(await composer.inputValue()).toBe(foregroundDraft);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount);
          expect(
            (await gateway.getRequests("sessions.list")).some(
              (request) => isRecord(request.params) && request.params.search === prompt,
            ),
          ).toBe(false);
          await input.fill(prompt.slice(0, 55));
          await page.waitForTimeout(100);
          expect(await search.evaluate((element: HTMLElement) => element.inert)).toBe(true);
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount);
          await input.fill(prompt.slice(0, 50));
          await expect.poll(() => input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
          await expect
            .poll(async () => (await gateway.getRequests("sessions.search")).length)
            .toBe(requestCount + 1);
          expect((await gateway.getRequests("sessions.search")).at(-1)?.params).toMatchObject({
            query: prompt.slice(0, 50),
          });
          await input.fill(prompt.slice(0, 59));
          expect(await search.evaluate((element: HTMLElement) => element.inert)).toBe(false);
          await expect
            .poll(async () => (await gateway.getRequests("sessions.search")).length)
            .toBe(requestCount + 2);
          expect((await gateway.getRequests("sessions.search")).at(-1)?.params).toMatchObject({
            query: prompt.slice(0, 59),
          });
          await input.fill(prompt);
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(true);
          await page.waitForTimeout(100);
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount + 2);
          await input.fill("");
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(false);
          await palette.getByRole("option", { name: "New session", exact: true }).waitFor();
          await input.fill("appearance");
          await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount + 3);
          expect((await palette.locator(".cmd-palette").boundingBox())!.y).toBe(original.y);
        },
      );
    },
  );

  it.each(["light", "dark"] as const)(
    "remembers only palette settings and restores defaults when unchecked in %s",
    async (mode) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), colorScheme: mode },
        async ({ page }) => {
          const base = scenario({
            "users.prefs.get": { status: "ok", entries: { "new-session.migration.v1": true } },
            "users.prefs.set": { status: "ok" },
          });
          const gateway = await installMockGateway(page, {
            ...base,
            featureMethods: [...(base.featureMethods ?? []), "users.prefs.get", "users.prefs.set"],
            presenceUsers: [{ self: true, id: "palette-user", name: "Example User" }],
          });
          const { composer, url, palette, input } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          const capture = captureAfter(page, "palette-remember-" + mode);
          const prompt = "Keep this prompt and its caret while changing preferences.";
          await input.fill(prompt);
          const popup = palette.locator("wa-popover.palette-session-settings");
          const trigger = palette.getByRole("button", {
            name: "New session settings",
            exact: true,
          });
          const openSettings = () => changePicker(popup, "wa-after-show", () => trigger.click());
          await openSettings();
          const remember = popup.getByRole("checkbox", { name: /Remember settings for/ });
          await expect.poll(() => remember.isEnabled()).toBe(true);
          expect(await remember.isChecked()).toBe(false);
          await capture("default-settings");
          const agent = popup.locator("openclaw-agent-select");
          await changePicker(agent.locator("wa-dropdown"), "wa-after-show", () =>
            agent.getByRole("button", { name: /^Agent:/ }).click(),
          );
          await changePicker(agent.locator("wa-dropdown"), "wa-after-hide", () =>
            agent.getByRole("menuitemradio", { name: "Reviewer", exact: true }).press("Escape"),
          );
          expect(await trigger.getAttribute("aria-expanded")).toBe("true");
          expect(
            await popup.getByRole("checkbox", { name: /Remember settings for/ }).isVisible(),
          ).toBe(true);
          await changePicker(agent.locator("wa-dropdown"), "wa-after-show", () =>
            agent.getByRole("button", { name: /^Agent:/ }).click(),
          );
          await agent.getByRole("menuitemradio", { name: "Reviewer", exact: true }).click();
          const paletteWrites = async () =>
            (await gateway.getRequests("users.prefs.set")).filter(
              (request) =>
                isRecord(request.params) &&
                isRecord(request.params.entries) &&
                Object.hasOwn(request.params.entries, "new-session.palette.v1"),
            );
          expect(await paletteWrites()).toHaveLength(0);
          await remember.check();
          await expect.poll(async () => (await paletteWrites()).length).toBe(1);
          const saved = (await paletteWrites())[0]!;
          expect(saved.params).toMatchObject({
            entries: { "new-session.palette.v1": { agentId: "reviewer" } },
          });
          if (!isRecord(saved.params) || !isRecord(saved.params.entries)) {
            throw new Error("Missing preference entries");
          }
          expect(Object.keys(saved.params.entries)).toEqual(["new-session.palette.v1"]);
          expect(await popup.getByRole("button", { name: "Use my defaults" }).count()).toBe(0);
          await changePicker(popup, "wa-after-hide", () =>
            popup.locator(".palette-session-settings__workspace").press("Escape"),
          );
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          await input.fill(prompt);
          // Establish the editor selection before opening settings. Chromium 151
          // restores its last focused range after a range is injected while blurred.
          await input.evaluate((element: HTMLTextAreaElement) => {
            element.focus();
            element.setSelectionRange(5, 11);
          });
          await openSettings();
          await expect
            .poll(() => agent.getByRole("button", { name: /^Agent:/ }).textContent())
            .toContain("Reviewer");
          expect(await remember.isChecked()).toBe(true);
          await capture("remembered-settings");
          await remember.uncheck();
          await expect.poll(async () => (await paletteWrites()).length).toBe(2);
          expect((await paletteWrites())[1]!.params).toMatchObject({
            entries: { "new-session.palette.v1": null },
          });
          await expect
            .poll(() => agent.getByRole("button", { name: /^Agent:/ }).textContent())
            .toContain("Main");
          await capture("unchecked-restores-defaults");
          expect(await input.inputValue()).toBe(prompt);
          expect(
            await input.evaluate((element: HTMLTextAreaElement) => [
              element.selectionStart,
              element.selectionEnd,
            ]),
          ).toEqual([5, 11]);
          expect(await composer.inputValue()).toBe(foregroundDraft);
          expect(page.url()).toBe(url);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
        },
      );
    },
  );

  it.each([false, true])(
    "settles a cold create shortcut exactly once (cancelled: %s)",
    async (cancelled) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const createdKey = "agent:main:dashboard:cold-created";
        const gateway = await installMockGateway(
          page,
          scenario({
            "sessions.create": { key: createdKey, runStarted: true, runId: "cold-run" },
          }),
        );
        const module = await holdModuleResponse(
          page,
          /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
        );
        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, foregroundKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
          await composer.fill(foregroundDraft);
          const url = page.url();
          await page.keyboard.press("ControlOrMeta+K");
          await module.request;
          const input = page.locator(".cmd-palette__input");
          await input.fill("Start exactly this cold task");
          await input.press("ControlOrMeta+Enter");
          await expect
            .poll(() => input.evaluate((element: HTMLTextAreaElement) => element.readOnly))
            .toBe(true);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          if (cancelled) {
            await page.keyboard.press("ControlOrMeta+K");
            await input.waitFor({ state: "hidden" });
          }
          module.release();
          await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
          if (cancelled) {
            await page.keyboard.press("ControlOrMeta+K");
            await input.waitFor({ state: "visible" });
            expect(await input.inputValue()).toBe("");
            expect(await gateway.getRequests("sessions.create")).toEqual([]);
          } else {
            await expect
              .poll(async () => (await gateway.getRequests("sessions.create")).length)
              .toBe(1);
            expect((await gateway.getRequests("sessions.create"))[0]!.params).toMatchObject({
              message: "Start exactly this cold task",
            });
            await input.waitFor({ state: "hidden" });
          }
          expect(page.url()).toBe(url);
          expect(await composer.inputValue()).toBe(foregroundDraft);
        } finally {
          module.release();
        }
      });
    },
  );

  it("keeps settings and session results as launcher actions instead of sending the query", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, scenario());
      const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
      const capture = captureAfter(page, "palette-mixed-results");
      await input.fill("appearance");
      const results = palette.locator(".cmd-palette__results");
      await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
      await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
      await palette
        .getByRole("option", { name: "Appearance Theme and UI settings.", exact: true })
        .waitFor();
      await capture("mixed-settings-and-session-results");
      await input.press("Enter");
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(appearanceKey));
      await input.waitFor({ state: "hidden" });

      await page.keyboard.press("ControlOrMeta+K");
      await input.fill("appearance");
      await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
      await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
      await input.press("ArrowDown");
      await expect
        .poll(() => palette.locator('[aria-selected="true"]').textContent())
        .toContain("Theme and UI settings.");
      await input.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      expect(await gateway.getRequests("sessions.create")).toEqual([]);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });

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
              "sessions.send": { runId: "palette-device-run", status: "started" },
            }),
          );
          const { composer, url, palette, input } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          const capture = captureAfter(page, "palette-create-" + destination);
          await capture("empty-launcher");
          const singleLineHeight = (await input.boundingBox())!.height;
          const prompt = [
            "Investigate missing worker error messages.",
            "Trace the failure through the session lifecycle.",
            "Compare local and paired-device execution.",
            "Propose an owner-level repair, not a retry.",
            "Add regression coverage for reconnects.",
            "Leave my current session untouched.",
          ].join("\n");
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
          expect((await input.boundingBox())!.height).toBeGreaterThan(singleLineHeight);
          const lineHeight = await input.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).lineHeight),
          );
          expect((await input.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 3 + 2);
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
          await capture("multiline-prompt-mode");

          const settings = palette.locator("wa-popover.palette-session-settings");
          await changePicker(settings, "wa-after-show", () =>
            palette.getByRole("button", { name: "New session settings", exact: true }).click(),
          );
          const agent = palette.locator("openclaw-agent-select");
          await changePicker(agent.locator("wa-dropdown"), "wa-after-show", () =>
            agent.getByRole("button", { name: /^Agent:/ }).click(),
          );
          const reviewer = agent.getByRole("menuitemradio", { name: "Reviewer", exact: true });
          await reviewer.waitFor();
          await reviewer.focus();
          await reviewer.press("Enter");
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
            const search = settings.getByRole("searchbox");
            await search.fill("Palette runner");
            await search.press("Escape");
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
          await capture("compact-session-settings");
          await changePicker(settings, "wa-after-hide", () =>
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
          await capture("selected-agent-and-destination");
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
            expect((await gateway.waitForRequest("sessions.send")).params).toMatchObject({
              key: sessionKey,
              message: submittedPrompt,
            });
          }
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          await page
            .locator(".app-toast")
            .getByRole("button", { name: "Open session", exact: true })
            .waitFor();
          await capture("foreground-preserved-after-start");
        },
      );
    },
  );

  it.each(["pointer", "keyboard"] as const)(
    "opens persistent rejected-turn recovery with %s after dismissing its toast",
    async (interaction) => {
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
        const prompt =
          "Keep this accepted session recoverable.\nDo not send the same request twice.";
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
        if (interaction === "pointer") {
          await recovery.click();
        } else {
          await input.focus();
          for (let step = 0; step < 10; step += 1) {
            await page.keyboard.press("Tab");
            if (await recovery.evaluate((element) => document.activeElement === element)) {
              break;
            }
          }
          expect(await recovery.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
          await page.keyboard.press("Enter");
        }
        await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
        await input.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );

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
      const capture = captureAfter(page, "palette-create-retry");
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
      await capture("creation-failure-retains-prompt");
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
