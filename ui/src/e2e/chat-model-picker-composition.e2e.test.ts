import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { installMockGateway } from "./chat-flow.test-support.ts";
import {
  polledAttribute,
  polledCount,
  polledText,
  polledVisible,
} from "./chat-presentation.test-support.ts";
import { modelAuthStatus, modelPicker } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mocked Gateway E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});
const accountLabel = "Sign in with ChatGPT";
const catalog = (
  models: { id: string; name: string; provider: string }[],
  authProfileId: string,
) => ({
  models,
  accountSelection: { kind: "shared", authProfileId, label: accountLabel },
});
const authStatus = (profileId: string, email: string) =>
  modelAuthStatus([{ profileId, type: "oauth", status: "ok", displayName: accountLabel, email }]);

suite.define(() => {
  it("loads accounts independently of the catalog and only enables the picker when ready", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = [{ id: "shared-alpha", name: "OpenAI Standard", provider: "openai" }];
      const modelResult = {
        models,
        accountSelection: { kind: "automatic", label: "Automatic account selection" },
      };
      const gateway = await installMockGateway(page, {
        agentModel: "openai/shared-alpha",
        models,
        methodResponses: {
          "models.list": { models },
        },
      });
      await page.goto(new URL("chat", suite.server.baseUrl).href);
      const { picker, trigger } = modelPicker(page);
      await trigger.waitFor();
      await gateway.waitForRequest("models.list");
      const rpc = "users.listModelAccounts";
      const catalogReads = await gateway.deferNext("models.list");
      const accountReads = await gateway.deferNext(rpc, {});
      await gateway.emitGatewayEvent("chat.metadata.changed", { modelCatalogChanged: true });
      await gateway.waitForRequest("models.list", { after: catalogReads });
      expect(await gateway.getRequests(rpc)).toHaveLength(accountReads);
      await trigger.click();
      expect((await gateway.waitForRequest(rpc, { after: accountReads })).params).toEqual({});
      await gateway.resolveDeferred("models.list", modelResult);
      const accountToggle = picker.getByRole("button", { name: "Account", exact: true });
      await polledText(accountToggle).toContain("Account: Auto");
      await expect.poll(() => accountToggle.isDisabled()).toBe(true);
      await polledVisible(accountToggle.locator(".chat-controls__account-spinner")).toBe(true);
      const popover = picker.locator(".chat-controls__account-popover:popover-open");
      expect(await popover.isVisible()).toBe(false);
      const loadingWidth = await accountToggle.evaluate((button) => button.clientWidth);
      expect(await gateway.getRequests(rpc)).toHaveLength(accountReads + 1);
      await gateway.rejectDeferred(rpc, { message: "Saved accounts are temporarily unavailable" });
      await expect.poll(() => accountToggle.isEnabled()).toBe(true);
      await accountToggle.press("Enter");
      await polledText(popover.getByRole("alert")).toContain(
        "Saved accounts are temporarily unavailable",
      );
      const retryReads = await gateway.deferNext(rpc, {});
      await popover.getByRole("button", { name: "Retry", exact: true }).click();
      await gateway.waitForRequest(rpc, { after: retryReads });
      expect(await accountToggle.isEnabled()).toBe(true);
      await gateway.resolveDeferred(rpc, {
        profileId: "test-person",
        accounts: [
          {
            authProfileId: "openai:work",
            label: "Work account",
            provider: "openai",
            authType: "oauth",
            selected: false,
          },
        ],
        links: [],
      });
      await expect.poll(() => accountToggle.isEnabled()).toBe(true);
      await polledVisible(accountToggle.locator("svg")).toBe(true);
      expect(await accountToggle.evaluate((button) => button.clientWidth)).toBe(loadingWidth);
      const alternate = popover.getByRole("option", { name: "Work account" });
      await polledVisible(alternate).toBe(true);
      await accountToggle.click();
      await polledVisible(popover).toBe(false);
      await accountToggle.click();
      await polledVisible(alternate).toBe(true);
      expect(await gateway.getRequests(rpc)).toHaveLength(accountReads + 2);
    });
  });

  it("refreshes the mounted composer's account identity after an auth publication", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = [{ id: "shared-alpha", name: "Shared Alpha", provider: "openai" }];
      const inventory = (authProfileId: string, label: string) => ({
        profileId: "test-person",
        accounts: [
          { authProfileId, label, provider: "openai", authType: "oauth", selected: false },
        ],
        links: [],
      });
      const gateway = await installMockGateway(page, {
        agentModel: "openai/shared-alpha",
        models,
        methodResponses: {
          "models.list": catalog(models, "openai:previous"),
          "models.authStatus": authStatus("openai:previous", "previous@example.test"),
          "users.listModelAccounts": inventory("openai:old-alternate", "Old alternate"),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const { picker, trigger, search } = modelPicker(page);
      await trigger.click();
      await polledCount(picker.locator("[data-chat-model-provider-toggle]")).toBe(0);
      const accountToggle = picker.locator(".chat-controls__account-trigger");
      await polledText(accountToggle).toContain(accountLabel);
      await accountToggle.click();
      const account = picker.locator('[data-chat-account-option="current"]');
      await polledText(account).toContain("previous@example.test");
      const oldAlternate = picker.locator(
        '[data-chat-account-option="account:openai:old-alternate"]',
      );
      await polledVisible(oldAlternate).toBe(true);

      await gateway.setMethodResponse("models.list", catalog(models, "openai:replacement"));
      await gateway.setMethodResponse(
        "models.authStatus",
        authStatus("openai:replacement", "replacement@example.test"),
      );
      await gateway.setMethodResponse(
        "users.listModelAccounts",
        inventory("openai:new-alternate", "New alternate"),
      );
      const catalogReads = (await gateway.getRequests("models.list")).length;
      await gateway.emitGatewayEvent("chat.metadata.changed", {
        authChanged: true,
        modelCatalogChanged: true,
      });
      await gateway.waitForRequest("models.list", { after: catalogReads });
      if ((await accountToggle.getAttribute("aria-expanded")) !== "true") {
        await accountToggle.click();
      }
      await polledText(account).toContain("replacement@example.test");
      expect(await account.textContent()).not.toContain("previous@example.test");
      expect(await picker.getAttribute("open")).not.toBeNull();
      const newAlternate = picker.locator(
        '[data-chat-account-option="account:openai:new-alternate"]',
      );
      await polledVisible(newAlternate).toBe(true);
      await search.fill("Old alternate");
      await polledVisible(picker.locator("[data-chat-model-search-empty]")).toBe(true);
      expect(await oldAlternate.count()).toBe(0);
      await search.fill("New alternate");
      await polledVisible(newAlternate).toBe(true);
    });
  });

  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])(
    "switches provider tabs and searches across all models at $width pixels",
    async ({ width, height }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        const models = [
          { id: "shared-alpha", name: "Shared Alpha", provider: "openai" },
          { id: "shared-beta", name: "Shared Beta", provider: "anthropic" },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/shared-alpha",
          models,
          presenceUsers: [{ id: "synthetic-operator", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          bootstrapPreferences: { profileId: "synthetic-operator", entries: {} },
          methodResponses: {
            "models.list": catalog(models, "openai:siwc"),
            "models.authStatus": authStatus("openai:siwc", "long-account-name+siwc@example.test"),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const { picker, trigger, search, option } = modelPicker(page);
        const alpha = option("openai/shared-alpha");
        const beta = option("anthropic/shared-beta");
        const openai = picker.locator('[data-chat-model-provider-toggle="openai"]');
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await trigger.click();
        await polledCount(picker.locator("[data-chat-model-provider-toggle]")).toBe(2);
        const auth = picker.locator(
          '[data-chat-model-provider="openai"] .chat-controls__auth-meta',
        );
        await polledText(auth).toContain("long-account-name+siwc@example.test");
        const accountToggle = picker.locator(".chat-controls__account-trigger");
        await accountToggle.click();
        await auth.waitFor({ state: "visible" });
        await accountToggle.click();
        await openai.click({ trial: true });
        const star = alpha.locator("[data-chat-model-favorite]");
        await star.click();
        await polledAttribute(star, "aria-pressed").toBe("true");
        const favorites = picker.locator('[data-chat-model-provider-toggle="$favorites"]');
        const favoriteIconFill = () =>
          favorites.locator("svg").evaluate((icon) => getComputedStyle(icon).fill);
        await expect.poll(favoriteIconFill).not.toBe("none");
        await favorites.click();
        await expect.poll(favoriteIconFill).not.toBe("none");
        await search.press("Escape");
        await polledAttribute(picker, "open").toBeNull();
        await trigger.click();
        await polledAttribute(favorites, "aria-selected").toBe("true");
        await openai.click();
        await polledVisible(alpha).toBe(true);
        await polledVisible(accountToggle).toBe(true);
        await accountToggle.click();
        await polledAttribute(accountToggle, "aria-expanded").toBe("true");
        await accountToggle.click();
        expect(await beta.isVisible()).toBe(false);
        expect(await openai.getAttribute("aria-selected")).toBe("true");
        await openai.focus();
        await page.keyboard.press("ArrowDown");
        await polledVisible(beta).toBe(true);
        await polledVisible(alpha).toBe(false);
        await page.keyboard.press("ArrowUp");
        await polledVisible(alpha).toBe(true);
        expect(await beta.isVisible()).toBe(false);
        await search.fill("shared");
        await polledVisible(beta).toBe(true);
        for (const query of ["shared-beta", "ANTHROPIC/SHARED-BETA"]) {
          await search.fill(query);
          expect({ beta: await beta.isVisible(), alpha: await alpha.isVisible() }).toEqual({
            beta: true,
            alpha: false,
          });
        }
        await search.press("ControlOrMeta+A");
        await search.press("Backspace");
        expect(await search.inputValue()).toBe("");
        await polledAttribute(openai, "aria-selected").toBe("true");
        expect(await alpha.isVisible()).toBe(true);
        expect(await beta.isVisible()).toBe(false);
        const anthropic = picker.locator('[data-chat-model-provider-toggle="anthropic"]');
        await anthropic.click();
        await polledVisible(alpha).toBe(false);
        await search.fill("shared");
        await search.press("Escape");
        expect(await search.inputValue()).toBe("");
        await polledAttribute(anthropic, "aria-selected").toBe("true");
        await search.press("Escape");
        await polledAttribute(picker, "open").toBeNull();
        await trigger.click();
        // A browsed provider without the selected model never survives closing.
        await polledVisible(alpha).toBe(true);
        expect(await openai.getAttribute("aria-selected")).toBe("true");
        expect(await search.inputValue()).toBe("");
        await search.fill("shared");
        if (width === 1280) {
          const highlighted = await search.getAttribute("aria-activedescendant");
          expect(highlighted).toBeTruthy();
          // Keep app-level key ownership and RPC admission alongside the component matrix.
          for (const composition of ["active", "keyCode229"]) {
            for (const key of ["Enter", "Escape"]) {
              const label = `${composition} ${key}`;
              const prevented = await search.evaluate(
                (input, args) => {
                  const event = new KeyboardEvent("keydown", {
                    key: args.key,
                    isComposing: args.composition === "active",
                    keyCode: args.composition === "keyCode229" ? 229 : 0,
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                  });
                  input.dispatchEvent(event);
                  return event.defaultPrevented;
                },
                { key, composition },
              );
              expect(prevented, label).toBe(false);
              expect(await picker.getAttribute("open"), label).not.toBeNull();
              expect(await search.inputValue(), label).toBe("shared");
              expect(await search.getAttribute("aria-activedescendant"), label).toBe(highlighted);
              expect(await gateway.getRequests("sessions.patch"), label).toEqual([]);
            }
          }
        }
        await search.press("ArrowDown");
        await search.press("Enter");
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toMatchObject({ model: "anthropic/shared-beta" });
        await polledAttribute(picker, "open").toBeNull();
        await trigger.click();
        await polledVisible(beta).toBe(true);
        expect(await alpha.isVisible()).toBe(false);
      });
    },
  );
});
