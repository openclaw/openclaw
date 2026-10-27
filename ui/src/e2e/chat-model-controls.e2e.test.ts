import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { modelSessionList } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model and effort controls" });

suite.define(() => {
  it("keeps a large pending model catalog usable in /chat", async () => {
    const contextOptions = { viewport: { width: 1280, height: 900 }, hasTouch: true };
    await suite.withPage(contextOptions, async ({ page }) => {
      const models = Array.from({ length: 1_000 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${String(index).padStart(4, "0")}`,
        provider: "example",
        contextWindow: 128_000,
      }));
      const gateway = await installMockGateway(page, {
        agentModel: "example/model-0",
        models,
        methodResponses: { "models.list": { models, pendingProviders: ["example"] } },
        sessionInfo: { model: "model-0", modelProvider: "example" },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__input").first();
      const picker = composer.locator(".chat-controls__model-picker");
      const trigger = picker.locator("[data-chat-model-select]");
      await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
      expect(await picker.locator("[data-chat-model-option]").count()).toBe(0);
      const textarea = composer.locator("textarea").first();
      await textarea.pressSequentially("catalog proof");
      expect(await textarea.inputValue()).toBe("catalog proof");
      await trigger.click();
      await expect.poll(() => picker.locator("[data-chat-model-option]").count()).toBe(9);
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      const refresh = picker.locator(".chat-controls__model-search-wrap [data-chat-model-refresh]");
      expect(await refresh.textContent()).toContain("Refreshing models for Example…");
      expect(await refresh.getAttribute("role")).toBe("status");
      expect(await refresh.locator(".btn__spinner").isVisible()).toBe(true);
      const requestsBeforeReopen = (await gateway.getRequests("models.list")).length;
      await trigger.click();
      await trigger.click();
      expect((await gateway.getRequests("models.list")).length).toBe(requestsBeforeReopen);
      const refreshDetails = refresh.getByRole("button");
      const openRefreshTooltip = refresh.locator("openclaw-tooltip[open]");
      await refreshDetails.waitFor({ state: "visible" });
      // The popup's opening scale animation can move this small target away
      // from a stationary pointer before the tooltip's hover delay completes.
      await picker.locator("[data-anchored-overlay]").evaluate(async (surface) => {
        await Promise.all(surface.getAnimations().map((animation) => animation.finished));
      });
      await refreshDetails.hover();
      await expect
        .poll(() => openRefreshTooltip.locator(".tooltip-content").textContent())
        .toBe("Refreshing models for Example…");
      const search = picker.locator("[data-chat-model-search]");
      await search.click();
      await search.press("Tab");
      expect(await refreshDetails.evaluate((button) => button === document.activeElement)).toBe(
        true,
      );
      await refreshDetails.press("Enter");
      await expect.poll(() => openRefreshTooltip.count()).toBe(1);
      await refreshDetails.press("Escape");
      await expect.poll(() => openRefreshTooltip.count()).toBe(0);
      expect(await picker.getAttribute("open")).not.toBeNull();
      await search.click();
      await refreshDetails.tap();
      await expect.poll(() => openRefreshTooltip.count()).toBe(1);
      await search.click();
      await expect.poll(() => openRefreshTooltip.count()).toBe(0);
      expect(await search.evaluate((input) => input === document.activeElement)).toBe(true);
      await search.pressSequentially("Model 0999");
      expect(await search.inputValue()).toBe("Model 0999");
      const result = picker.locator('[data-chat-model-option="example/model-999"]');
      await expect.poll(() => result.isVisible()).toBe(true);
      expect(await picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
      expect(await result.isEnabled()).toBe(true);
      await search.clear();
      await trigger.focus();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await search.pressSequentially("Model 0999");
      expect(await search.inputValue()).toBe("Model 0999");
      await expect.poll(() => result.isVisible()).toBe(true);
      expect(await picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
      expect(
        await refresh
          .locator(".btn__spinner")
          .evaluate((node) => getComputedStyle(node).animationName),
      ).toBe("none");
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).not.toHaveProperty("refresh", true);
      }
      await refreshDetails.focus();
      expect(await refreshDetails.evaluate((button) => button === document.activeElement)).toBe(
        true,
      );
      await gateway.setMethodResponse("models.list", { models });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect.poll(() => refresh.count()).toBe(0);
      expect(await search.evaluate((input) => input === document.activeElement)).toBe(true);
      expect(await search.inputValue()).toBe("Model 0999");
      await search.press("ArrowDown");
      expect(await result.getAttribute("data-chat-model-highlighted")).not.toBeNull();
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      expect(await picker.getAttribute("open")).not.toBeNull();
      await result.click();
      await expect.poll(() => trigger.textContent()).toContain("Model 0999");
      expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
        expectedSessionId: "session:agent:main:main",
        model: "example/model-999",
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const sessions = page.locator('[data-navigation-view="sessions"]');
      if ((await sessions.getAttribute("aria-pressed")) !== "true") {
        await sessions.click();
      }
      await expect.poll(() => sessions.getAttribute("aria-pressed")).toBe("true");
      const toggleSidebar = async () => {
        for (const pressed of ["false", "true"]) {
          await sessions.click();
          await expect.poll(() => sessions.getAttribute("aria-pressed")).toBe(pressed);
          await page.locator(".shell").evaluate(async (shell) => {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
            await Promise.all(shell.getAnimations().map((animation) => animation.finished));
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
          });
        }
      };
      await toggleSidebar();
      const requestsBeforeToggle = (await gateway.getRequests("models.list")).length;
      await toggleSidebar();
      expect(await trigger.textContent()).toContain("Model 0999");
      expect((await gateway.getRequests("models.list")).length).toBe(requestsBeforeToggle);
    });
  });

  it.each(["pointer", "keyboard"])("changes only this chat's account (%s)", async (input) => {
    await suite.withPage(
      {
        viewport: { width: 393, height: 852 },
      },
      async ({ page }) => {
        const personal = {
          authProfileId: "openai:personal",
          provider: "openai",
          label: "Test Person · Personal workspace",
          authType: "oauth",
          selected: false,
        };
        const work = {
          ...personal,
          authProfileId: "openai:work",
          label: "Test Person · Work workspace",
          selected: true,
        };
        const models = [
          {
            id: "gpt-5.5",
            provider: "openai",
            name: "GPT-5.5",
            reasoning: false,
            thinkingLevels: [],
          },
        ];
        const sessionKey = "agent:main:main";
        const sessionList = modelSessionList(
          {
            key: sessionKey,
            kind: "direct",
            model: "gpt-5.5",
            modelProvider: "openai",
            updatedAt: 1,
          },
          { model: "gpt-5.5", modelProvider: "openai", contextTokens: 200_000 },
        );
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.5",
          models,
          deferredMethods: ["sessions.patch"],
          methodResponses: {
            "sessions.list": sessionList,
            "models.authStatus": {
              ts: 1,
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "ok",
                  profiles: [
                    {
                      profileId: personal.authProfileId,
                      type: "oauth",
                      status: "ok",
                      email: "personal@example.com",
                    },
                    {
                      profileId: work.authProfileId,
                      type: "oauth",
                      status: "ok",
                      email: "work@example.com",
                    },
                  ],
                  usage: { providerId: "openai", windows: [], plan: "ChatGPT Pro" },
                },
              ],
            },
            "models.list": {
              commands: [],
              models,
              accountSelection: {
                kind: "personal",
                label: personal.label,
                authProfileId: personal.authProfileId,
                source: "user",
              },
            },
            "users.listModelAccounts": {
              profileId: "test-person",
              // Reopening retries an empty inventory; a populated one stays cached.
              accounts: input === "keyboard" ? [] : [personal],
              nextCursor: "accounts-page-2",
              links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 1 }],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input").first();
        const model = composer.locator('[data-chat-model-select="true"]');
        await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
        await composer.locator("textarea").click();
        await model.click();
        const heading = composer.locator('[data-chat-model-provider="openai"]');
        await expect
          .poll(() => heading.textContent())
          .toContain("Subscription · personal@example.com");
        const account = composer.locator("[data-chat-account-selection]");
        const picker = account;
        const trigger = picker.locator("[data-chat-account-group-toggle]");
        await expect.poll(() => trigger.textContent()).toContain(personal.label);
        for (const width of [320, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await heading.getAttribute("title")).toBe("Subscription · personal@example.com");
          expect(
            await heading.locator(".chat-controls__auth-meta svg").evaluate((icon) => ({
              width: getComputedStyle(icon).width,
              height: getComputedStyle(icon).height,
            })),
          ).toEqual({ width: "13px", height: "13px" });
          await expect
            .poll(async () => {
              const box = await trigger.boundingBox();
              return Boolean(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1);
            })
            .toBe(true);
        }
        await trigger.click();
        const more = picker.locator('[data-chat-account-option="more"]');
        await expect.poll(() => more.isVisible()).toBe(true);
        expect(
          await picker.locator('[data-chat-account-option="current"]').textContent(),
        ).toContain("personal@example.com");
        await trigger.click();
        await expect.poll(() => more.isVisible()).toBe(false);
        await expect.poll(() => account.isVisible()).toBe(true);
        await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
        const refreshRequests = await gateway.getRequests("users.listModelAccounts");
        if (input === "keyboard") {
          await gateway.deferNext("users.listModelAccounts", {});
        }
        await trigger.press("Enter");
        await expect.poll(() => more.isVisible()).toBe(true);
        const pendingMoreTarget = await more.elementHandle();
        expect(pendingMoreTarget).not.toBeNull();
        if (input === "keyboard") {
          const refresh = await gateway.waitForRequest("users.listModelAccounts", {
            after: refreshRequests.length,
          });
          expect(refresh.params).toEqual({});
          const loading = picker.locator('[data-chat-account-option="loading"]');
          await expect.poll(() => loading.isVisible()).toBe(true);
          expect(await pendingMoreTarget!.isDisabled()).toBe(true);
          await pendingMoreTarget!.focus();
          await gateway.resolveDeferred("users.listModelAccounts", {
            profileId: "test-person",
            accounts: [personal],
            nextCursor: "accounts-page-2",
            links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 1 }],
          });
          await expect.poll(() => loading.isVisible()).toBe(false);
          await expect.poll(() => pendingMoreTarget!.isEnabled()).toBe(true);
          await expect
            .poll(() =>
              pendingMoreTarget!.evaluate((element) => element === document.activeElement),
            )
            .toBe(true);
        } else {
          expect(await gateway.getRequests("users.listModelAccounts")).toEqual(refreshRequests);
        }
        expect(
          await picker
            .locator('[data-chat-account-option="current"]')
            .getAttribute("aria-selected"),
        ).toBe("true");
        const loading = picker.locator('[data-chat-account-option="loading"]');
        const beginAccountPage = async (cursor: string) => {
          const requestsBefore = await gateway.getRequests("users.listModelAccounts");
          await gateway.deferNext("users.listModelAccounts", { cursor });
          const beforeUrl = page.url();
          if (input === "keyboard") {
            await page.keyboard.press("Enter");
          } else {
            await pendingMoreTarget!.click();
          }
          await expect
            .poll(
              async () =>
                (await gateway.getRequests("users.listModelAccounts")).length >
                  requestsBefore.length || page.url() !== beforeUrl,
            )
            .toBe(true);
          expect(page.url()).toBe(beforeUrl);
          const request = await gateway.waitForRequest("users.listModelAccounts", {
            after: requestsBefore.length,
          });
          expect(request.params).toEqual({ cursor });
          await expect.poll(() => loading.isVisible()).toBe(true);
          expect(await pendingMoreTarget!.isDisabled()).toBe(true);
          if (input === "keyboard") {
            await page.keyboard.press("Enter");
          } else {
            await pendingMoreTarget!.hover();
            expect(await pendingMoreTarget!.evaluate((row) => row.matches(":hover"))).toBe(true);
            await page.mouse.down();
            await page.mouse.up();
          }
          expect(await gateway.getRequests("users.listModelAccounts")).toHaveLength(
            requestsBefore.length + 1,
          );
          expect(page.url()).toBe(beforeUrl);
        };
        await beginAccountPage("accounts-page-2");
        await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
        await gateway.resolveDeferred("users.listModelAccounts", {
          profileId: "test-person",
          accounts: [work],
          nextCursor: "accounts-page-3",
          links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 1 }],
        });
        await expect.poll(() => loading.isVisible()).toBe(false);
        await expect.poll(() => pendingMoreTarget!.isEnabled()).toBe(true);
        if (input === "keyboard") {
          expect(await pendingMoreTarget!.evaluate((row) => row === document.activeElement)).toBe(
            true,
          );
        }
        await beginAccountPage("accounts-page-3");
        const manage = picker.locator('[data-chat-account-option="manage"]');
        if (input === "keyboard") {
          await manage.focus();
        }
        await gateway.resolveDeferred("users.listModelAccounts", {
          profileId: "test-person",
          accounts: [],
          links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 1 }],
        });
        await expect.poll(() => loading.isVisible()).toBe(false);
        await expect.poll(() => more.isVisible()).toBe(false);
        if (input === "keyboard") {
          expect(await manage.evaluate((button) => button === document.activeElement)).toBe(true);
        }
        const workOption = picker.locator(
          `[data-chat-account-option="account:${work.authProfileId}"]`,
        );
        await expect.poll(() => workOption.isVisible()).toBe(true);
        expect(await workOption.textContent()).toContain("work@example.com");
        await trigger.click();
        const search = composer.locator("[data-chat-model-search]");
        await search.fill("account");
        await expect.poll(() => workOption.isVisible()).toBe(true);
        if (input === "keyboard") {
          await workOption.press("Enter");
        } else {
          await workOption.click();
        }
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toEqual({
          expectedSessionId: `session:${sessionKey}`,
          key: sessionKey,
          model: `openai/gpt-5.5@${work.authProfileId}`,
        });
        // A pending model override must not change the confirmed account.
        const currentOption = picker.locator('[data-chat-account-option="current"]');
        await expect.poll(() => currentOption.isVisible()).toBe(true);
        expect(await currentOption.textContent()).toContain(personal.label);
        expect(await currentOption.getAttribute("aria-selected")).toBe("true");
        expect(await search.isDisabled()).toBe(true);
        await gateway.resolveDeferred("sessions.patch", { ok: true });
        await gateway.setMethodResponse("sessions.list", sessionList);
        await gateway.setMethodResponse("models.list", {
          commands: [],
          models,
          accountSelection: {
            kind: "personal",
            label: work.label,
            authProfileId: work.authProfileId,
            source: "user",
          },
        });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await gateway.emitGatewayEvent("sessions.changed", {
          key: sessionKey,
          agentId: "main",
          reason: "patch",
        });
        await search.clear();
        await expect.poll(() => trigger.textContent()).toContain(work.label);
        await expect.poll(() => heading.textContent()).toContain("Subscription · work@example.com");
        expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(0);
        expect(await gateway.getRequests("users.unlinkAuthProfile")).toHaveLength(0);
      },
    );
  });

  it.each(["chat", "new"])(
    "keeps independent model and effort controls within the %s composer",
    async (route) => {
      await suite.withPage({ viewport: { width: 393, height: 852 } }, async ({ page }) => {
        const longName =
          "Long catalog display name for a model with a very large context window and detailed reasoning capabilities";
        const thinkingLevels = [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-luna",
          models: [
            {
              id: "gpt-5.6-luna",
              provider: "openai",
              name: longName,
              reasoning: true,
              thinkingLevels,
            },
            {
              id: "speed-only",
              provider: "openai",
              name: "Speed only",
              reasoning: false,
              thinkingLevels: [],
            },
            {
              id: "basic",
              provider: "example",
              name: "Basic",
              reasoning: false,
              thinkingLevels: [],
            },
          ],
          methodResponses: {
            "sessions.list": modelSessionList(
              {
                key: "agent:main:main",
                kind: "direct",
                model: "gpt-5.6-luna",
                modelProvider: "openai",
                updatedAt: 1,
                contextTokens: 200_000,
                totalTokens: 46_000,
                totalTokensFresh: true,
              },
              {
                model: "gpt-5.6-luna",
                modelProvider: "openai",
                thinkingDefault: "high",
                thinkingLevels,
                contextTokens: 200_000,
              },
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(".agent-chat__input").first();
        const model = composer.locator('[data-chat-model-select="true"]');
        const effort = composer.locator('[data-chat-thinking-select="true"]');
        await expect.poll(() => model.getAttribute("aria-label")).toContain(longName);
        await composer.locator("textarea").click();
        await expect.poll(() => effort.isVisible()).toBe(true);
        for (const width of [320, 375, 393, 430, 560, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await composer.locator("textarea").click();
          await expect
            .poll(
              async () => {
                const [modelBox, effortBox, actionsBox, composerBox] = await Promise.all([
                  model.boundingBox(),
                  effort.boundingBox(),
                  composer.locator(".agent-chat__composer-actions").boundingBox(),
                  composer.boundingBox(),
                ]);
                return Boolean(
                  modelBox &&
                  effortBox &&
                  actionsBox &&
                  composerBox &&
                  modelBox.width > 0 &&
                  effortBox.width >= 44 &&
                  modelBox.x >= composerBox.x &&
                  modelBox.x + modelBox.width <= effortBox.x + 1 &&
                  effortBox.x + effortBox.width <= actionsBox.x + 1 &&
                  actionsBox.x + actionsBox.width <= composerBox.x + composerBox.width + 1,
                );
              },
              { message: `nonoverlapping ${route} controls at ${width}px` },
            )
            .toBe(true);
          const label = await model
            .locator(".chat-controls__inline-select-label")
            .evaluate((node) => ({
              content: node.textContent?.trim(),
              clipped: node.scrollWidth > node.clientWidth,
              overflow: getComputedStyle(node).overflow,
              textOverflow: getComputedStyle(node).textOverflow,
            }));
          expect(label).toEqual({
            content: longName,
            clipped: true,
            overflow: "hidden",
            textOverflow: "ellipsis",
          });
          expect(await model.getAttribute("aria-label")).toContain(longName);
          await model.click();
          const menu = composer.locator(".chat-controls__model-menu");
          await expect.poll(() => menu.isVisible()).toBe(true);
          expect(await menu.getByText(/^(?:Effort|Speed)$/).count()).toBe(0);
          expect(
            await menu.locator("[data-chat-thinking-slider], [data-chat-speed-option]").count(),
          ).toBe(0);
          await revealChatModelOption(composer, "openai/gpt-5.6-luna");
          await expect
            .poll(() => menu.getByRole("option", { name: new RegExp(longName) }).count())
            .toBe(1);
          await page.keyboard.press("Escape");
          await expect
            .poll(() => model.evaluate((node) => node === document.activeElement))
            .toBe(true);
        }
        await page.setViewportSize({ width: 393, height: 852 });
        await composer.locator("textarea").click();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        const needle = effort.locator(".chat-controls__effort-gauge-needle");
        const needleAngle = () =>
          needle.evaluate((node) => {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
            return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
          });
        await expect.poll(needleAngle).toBe(120);
        expect(
          await needle.evaluate((node) =>
            Number.parseFloat(getComputedStyle(node).transitionDuration),
          ),
        ).toBeGreaterThan(0);
        expect(await needle.evaluate((node) => node.namespaceURI)).toBe(
          "http://www.w3.org/2000/svg",
        );
        await effort.click();
        const slider = composer.locator('[data-chat-thinking-slider="true"]');
        await expect.poll(() => slider.isVisible()).toBe(true);
        await slider.press("Home");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        await expect.poll(needleAngle).toBe(-120);
        if (route === "chat") {
          expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
            key: "agent:main:main",
            thinkingLevel: "low",
          });
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await needle.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe(
          "none",
        );
        await slider.press("End");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        expect(await needleAngle()).toBe(120);
        // The expanded picker suppresses its trigger hint while owning Escape.
        await slider.hover();
        const openTooltips = page.locator("openclaw-tooltip[open]");
        await expect.poll(() => openTooltips.count()).toBe(0);
        expect(await slider.evaluate((node) => node === document.activeElement)).toBe(true);
        await effort.hover();
        await expect.poll(() => openTooltips.count()).toBe(0);
        expect(await slider.isVisible()).toBe(true);
        expect(await slider.inputValue()).toBe("1");
        expect(await effort.getAttribute("data-chat-thinking-value")).toBe("high");
        expect(await slider.evaluate((node) => node === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => slider.isVisible()).toBe(false);
        await expect
          .poll(() => effort.evaluate((node) => node === document.activeElement))
          .toBe(true);
        if (route === "chat") {
          await page.setViewportSize({ width: 1180, height: 900 });
          await selectChatLayoutAction(page, "Open split view");
          const panes = page.locator(".chat-split-view__pane .agent-chat__input");
          await expect.poll(() => panes.count()).toBe(2);
          await expect
            .poll(() =>
              panes.evaluateAll((inputs) =>
                inputs.every((input) => {
                  const paneModel = input.querySelector<HTMLElement>(
                    '[data-chat-model-select="true"]',
                  );
                  const paneEffort = input.querySelector<HTMLElement>(
                    '[data-chat-thinking-select="true"]',
                  );
                  const actions = input.querySelector<HTMLElement>(".agent-chat__composer-actions");
                  if (!paneModel || !paneEffort || !actions) {
                    return false;
                  }
                  const modelBox = paneModel.getBoundingClientRect();
                  const effortBox = paneEffort.getBoundingClientRect();
                  return (
                    input.getBoundingClientRect().width <= 480 &&
                    modelBox.width > 0 &&
                    effortBox.width > 0 &&
                    modelBox.right <= effortBox.left + 1 &&
                    effortBox.right <= actions.getBoundingClientRect().left + 1
                  );
                }),
              ),
            )
            .toBe(true);
        }
        await model.click();
        await composer.locator("[data-chat-model-search]").fill("Speed only");
        await composer.locator('[data-chat-model-option="openai/speed-only"]').click();
        if (route === "chat") {
          await expect
            .poll(async () =>
              (await gateway.getRequests("sessions.patch")).map(({ params }) => params),
            )
            .toContainEqual({
              expectedSessionId: "session:agent:main:main",
              key: "agent:main:main",
              model: "openai/speed-only",
            });
        } else {
          await expect.poll(() => effort.count()).toBe(1);
          await expect.poll(() => effort.getAttribute("aria-label")).toBe("Speed: Standard");
          await effort.click();
          await expect
            .poll(() =>
              composer.locator('[data-chat-speed-option="on"]').getAttribute("aria-checked"),
            )
            .toBe("false");
          await model.click();
          await selectChatModelOption(composer, "example/basic");
          await expect.poll(() => effort.count()).toBe(0);
        }
      });
    },
  );
  it.each([
    { provider: "openai", reasoning: false, capability: "non-reasoning" },
    { provider: "example", reasoning: false, capability: "non-reasoning" },
    { provider: "metadata-fixture", reasoning: true, capability: "no-effort" },
  ])(
    "keeps $provider $capability capabilities reachable without a model-menu bridge",
    async ({ provider, reasoning }) => {
      await suite.withPage({ viewport: { width: 320, height: 852 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: `${provider}/basic`,
          models: [
            {
              id: "basic",
              provider,
              name: "Basic",
              reasoning,
              thinkingLevels: [],
              thinkingDefault: "off",
            },
          ],
          methodResponses: {
            "sessions.list": modelSessionList(
              {
                key: "agent:main:main",
                kind: "direct",
                model: "basic",
                modelProvider: provider,
                thinkingLevels: [],
                thinkingDefault: "off",
                contextTokens: 200_000,
                totalTokens: 46_000,
                totalTokensFresh: true,
                updatedAt: 1,
              },
              {
                model: "basic",
                modelProvider: provider,
                thinkingLevels: [],
                thinkingDefault: "off",
                contextTokens: 200_000,
              },
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input");
        const model = composer.locator('[data-chat-model-select="true"]');
        await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
        const effort = composer.locator('[data-chat-thinking-select="true"]');
        if (provider !== "openai") {
          await expect.poll(() => effort.count()).toBe(0);
          expect(
            (await gateway.getRequests("sessions.patch")).some(
              ({ params }) => params && Object.hasOwn(params, "thinkingLevel"),
            ),
          ).toBe(false);
          return;
        }
        await expect.poll(() => effort.getAttribute("aria-label")).toBe("Speed: Standard");
        await composer.locator("textarea").click();
        const [modelBox, effortBox, actionsBox] = await Promise.all([
          model.boundingBox(),
          effort.boundingBox(),
          composer.locator(".agent-chat__composer-actions").boundingBox(),
        ]);
        expect(modelBox).not.toBeNull();
        expect(effortBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(effortBox!.x + 1);
        expect(effortBox!.x + effortBox!.width).toBeLessThanOrEqual(actionsBox!.x + 1);
        expect(effortBox!.width).toBeGreaterThanOrEqual(44);
        await effort.click();
        expect(await composer.locator("[data-chat-thinking-slider]").count()).toBe(0);
        await composer.getByRole("radio", { name: "Fast", exact: true }).click();
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          key: "agent:main:main",
          fastMode: true,
        });
        await expect.poll(() => effort.getAttribute("aria-label")).toBe("Speed: Fast");
        await page.keyboard.press("Escape");
        await expect
          .poll(() => effort.evaluate((node) => node === document.activeElement))
          .toBe(true);
      });
    },
  );
});
