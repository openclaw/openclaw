import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "New Session revisit" });

async function failDraftRender(page: Page, persistFailure: boolean, failInitially = true) {
  await page.addInitScript(
    ({ persistent, initial }) => {
      const boots = Number(sessionStorage.getItem("test.newSessionBoots") ?? "0") + 1;
      sessionStorage.setItem("test.newSessionBoots", String(boots));
      Reflect.set(globalThis, "failNewSessionRender", initial && (persistent || boots === 1));
      const defineProperty = Object.defineProperty;
      Object.defineProperty = (target, key, descriptor) => {
        const isDraft =
          target instanceof HTMLElement && target.localName === "openclaw-new-session-page";
        if (isDraft && key === "data" && descriptor.get) {
          const read = descriptor.get.bind(target);
          return defineProperty(target, key, {
            ...descriptor,
            get() {
              if (Reflect.get(globalThis, "failNewSessionRender")) {
                throw new Error("Synthetic draft renderer failure");
              }
              return read();
            },
          });
        }
        return defineProperty(target, key, descriptor);
      };
    },
    { persistent: persistFailure, initial: failInitially },
  );
}

type DraftFixture = {
  page: Page;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  composer: ReturnType<Page["locator"]>;
};

function withDraft(
  run: (fixture: DraftFixture) => Promise<void>,
  scenario: ControlUiMockGatewayScenario = {},
) {
  return suite.withPage(
    { viewport: { width: 1280, height: 900 }, locale: "en-US" },
    async ({ page }) => {
      const gateway = await installMockGateway(page, { awaitInitialRoster: true, ...scenario });
      await run({ page, gateway, composer: page.locator(".new-session-page__message") });
    },
  );
}

const openDraft = (page: Page, route = "new?agent=main") => page.goto(suite.server.baseUrl + route);
const openChat = (page: Page) => page.locator("openclaw-chat-page").waitFor({ state: "visible" });
const returnToDraft = async (page: Page) => {
  await page.getByRole("link", { name: "New conversation" }).first().click();
  await page.locator(".new-session-page__message").waitFor({ state: "visible" });
};

async function recoverComposer({ page, gateway, composer }: DraftFixture, persistent: boolean) {
  await failDraftRender(page, persistent);
  await openDraft(page);
  if (persistent) {
    await page.waitForFunction(() => sessionStorage.getItem("test.newSessionBoots") === "2");
    const error = page.locator("openclaw-new-session-page .lazy-view-error");
    await error.waitFor({ state: "visible", timeout: 5000 });
    // Retrying a persistent failure must not trigger a third document load.
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await error.waitFor({ state: "visible" });
    expect(await page.evaluate(() => sessionStorage.getItem("test.newSessionBoots"))).toBe("2");
    await page.evaluate(() => Reflect.set(globalThis, "failNewSessionRender", false));
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await composer.fill("Recovered without a browser refresh");
    expect(await composer.inputValue()).toBe("Recovered without a browser refresh");
    expect(await error.count()).toBe(0);
  } else {
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    expect(await page.evaluate(() => sessionStorage.getItem("test.newSessionBoots"))).toBe("2");
    await composer.fill("Recovered automatically");
  }
  await composer.press("Enter");
  await gateway.waitForRequest("sessions.create");
  await openChat(page);
}

async function preserveDraft({ page, composer }: DraftFixture) {
  await failDraftRender(page, false, false);
  await openDraft(page);
  await composer.fill("Keep this unsent draft");
  await page.evaluate(() => {
    const host = document.querySelector("openclaw-new-session-page");
    if (!host) {
      throw new Error("Missing New Session host");
    }
    const data = { ...Reflect.get(host, "data") };
    Reflect.set(globalThis, "failNewSessionRender", true);
    Reflect.set(host, "data", data);
  });
  const error = page.locator("openclaw-new-session-page .lazy-view-error");
  await error.waitFor({ state: "visible" });
  await page.evaluate(() => Reflect.set(globalThis, "failNewSessionRender", false));
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await composer.waitFor({ state: "visible" });
  expect(await composer.inputValue()).toBe("Keep this unsent draft");
  expect(await page.evaluate(() => sessionStorage.getItem("test.newSessionBoots"))).toBe("1");
}

async function interruptNavigation(
  { page, gateway, composer }: DraftFixture,
  method: "chat.startup" | "sessions.create",
) {
  await openDraft(page);
  await composer.fill("Interrupted session");
  await gateway.deferNext(method);
  await composer.press("Enter");
  await gateway.waitForRequest(method);
  if (method === "chat.startup") {
    await returnToDraft(page);
    await gateway.resolveDeferred(method);
    await composer.fill("Still usable");
    expect(await composer.inputValue()).toBe("Still usable");
  } else {
    await openChat(page);
    const rejection = { code: "UNAVAILABLE", message: "Synthetic rejection" };
    await gateway.rejectDeferred(method, rejection);
    await composer.waitFor({ state: "visible" });
    await returnToDraft(page);
    await composer.fill("Retry after rollback");
    await composer.press("Enter");
    await gateway.waitForRequest(method, { after: 1 });
    await openChat(page);
    await returnToDraft(page);
    expect(await composer.isEnabled()).toBe(true);
  }
}

async function visitChats({ page, gateway, composer }: DraftFixture) {
  await openDraft(page, "new");
  await composer.waitFor({ state: "visible" });
  for (let visit = 0; visit < 2; visit++) {
    await composer.fill("Revisit session " + visit);
    await composer.press("Enter");
    await gateway.waitForRequest("sessions.create", { after: visit });
    await openChat(page);
    await page.getByRole("link", { name: "New conversation" }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await composer.waitFor({ state: "visible", timeout: 5000 });
    expect(await composer.isEnabled()).toBe(true);
  }
}

suite.define(() => {
  it.each([false, true])(
    "restores the composer after a render failure (persistent: %s)",
    (persistent) =>
      withDraft((fixture) => recoverComposer(fixture, persistent), { awaitInitialRoster: false }),
  );
  it("keeps a draft and avoids automatic reload after the composer was usable", () =>
    withDraft(preserveDraft));
  it.each(["chat.startup", "sessions.create"] as const)(
    "returns to plus after interrupted %s",
    (method) =>
      withDraft((fixture) => interruptNavigation(fixture, method), {
        subscriptionInitialHistory: method !== "chat.startup",
      }),
  );
  it("keeps the plus destination populated across repeated chat visits", () =>
    withDraft(visitChats));
});
