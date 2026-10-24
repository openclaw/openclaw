import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalogList } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar refresh availability" });
const catalogMethod = "sessions.catalog.list";
const suspensionError = {
  code: "UNAVAILABLE",
  message: "sessions.catalog.list unavailable during gateway suspension",
  retryable: true,
  details: { reason: "gateway-suspending", phase: "draining", method: catalogMethod },
};

async function reactivatePage(page: Page): Promise<void> {
  await pauseVirtualClock(page);
  await page.evaluate(() => {
    for (const value of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await page.clock.fastForward(5_001);
  await page.clock.resume();
}

const catalog = (name: string) =>
  catalogList({
    id: "codex",
    label: "Codex",
    host: "Local Codex",
    thread: "synthetic-thread",
    name,
    status: "idle",
    archive: true,
  });

async function checkRefreshAvailability({ page }: { page: Page }) {
  await page.clock.install();
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, catalogMethod],
    methodResponses: { [catalogMethod]: catalog("Retained sample session") },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  const sidebar = page.locator("openclaw-app-sidebar");
  const connectionStatus = page.locator(".sidebar-shell__footer .gateway-status");
  const connectionLabel = connectionStatus.locator(".gateway-status__label");
  const expectSuspending = async () => {
    await expect.poll(() => connectionLabel.textContent()).toBe("Suspending…");
    expect(await sidebar.getByRole("alert").count()).toBe(0);
  };
  const retained = sidebar.getByText("Retained sample session", { exact: true });
  await retained.waitFor();
  await gateway.setMethodResponse(catalogMethod, { __mockError: suspensionError });
  const beforeSuspension = await gateway.deferNext(catalogMethod);
  await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
  await reactivatePage(page);
  await gateway.waitForRequest(catalogMethod, { after: beforeSuspension });
  await gateway.rejectDeferred(catalogMethod, suspensionError);
  await expectSuspending();
  expect(await retained.isVisible()).toBe(true);
  const before = (await gateway.getRequests(catalogMethod)).length;
  await gateway.setMethodResponse(catalogMethod, catalog("Recovered sample session"));
  await pauseVirtualClock(page);
  await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
  await page.clock.fastForward(5_001);
  await page.clock.resume();
  await sidebar.getByText("Recovered sample session", { exact: true }).waitFor();
  await connectionStatus.waitFor({ state: "detached" });
  expect((await gateway.getRequests(catalogMethod)).length).toBe(before + 1);
  expect(await gateway.getSocketCount()).toBe(1);
  expect(await sidebar.getByRole("alert").count()).toBe(0);
}
suite.define(() => {
  it("keeps suspension in the footer and refreshes retained rows when admission reopens", () =>
    suite.withPage({ viewport: { width: 1440, height: 900 } }, checkRefreshAvailability));
});
