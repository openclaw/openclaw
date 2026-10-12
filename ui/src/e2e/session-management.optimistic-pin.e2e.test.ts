import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const candidateKey = "agent:main:candidate";
const companionKey = "agent:main:companion";
const pinRef = "session:agent:main:candidate";
const profileId = "profile-pin-owner";
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const pinsKey = "ui.railShortcuts";

function profilePreferences(sidebarEntries: string[]) {
  return { status: "ok", entries: { [pinsKey]: sidebarEntries } };
}

async function installPinGateway(page: Page, sidebarEntries: string[] = []) {
  const owner = { actor: { type: "human", id: profileId, label: "Pin owner" } };
  return installMockGateway(page, {
    methodResponses: {
      // Profile hydration waits for the runtime configuration snapshot, not just presence.
      "config.get": { config: {}, hash: "pin-profile-config" },
      "sessions.list": sessionsListResponse([
        sessionRow(candidateKey, "Pin me", baseTime, { owner }),
        sessionRow(companionKey, "Stay put", baseTime - 1_000, { owner }),
      ]),
      "users.prefs.get": profilePreferences(sidebarEntries),
      "users.prefs.set": { status: "ok" },
    },
    featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
    presenceUsers: [{ self: true, id: profileId, name: "Pin owner" }],
    sessionKey: candidateKey,
  });
}

function personalPin(page: Page) {
  return page.locator('.sidebar-rail [data-sidebar-entry="session:agent:main:candidate"]');
}

function candidateRow(page: Page) {
  return page.locator(
    '.sidebar-session-content .sidebar-recent-session[data-session-key="agent:main:candidate"]',
  );
}

async function storedPins(page: Page) {
  return page.evaluate(
    ({ key, profile }) =>
      JSON.parse(localStorage.getItem(key) ?? "{}").navigationByProfile?.[profile]?.railShortcuts,
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), profile: profileId },
  );
}

async function pendingPinWrites(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("openclaw.control.serverPrefs.pending.v1:"))
      .map((key) => JSON.parse(localStorage.getItem(key) ?? "null"))
      .filter((value) => value && Object.hasOwn(value, "railShortcuts")),
  );
}

async function expectNoSharedPinWrites(gateway: MockGatewayControls) {
  expect(await gateway.getRequests("sessions.patch")).toEqual([]);
  expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
  expect(await gateway.getRequests("config.patch")).toEqual([]);
}

async function confirmPinWrite(gateway: MockGatewayControls, sidebarEntries: string[]) {
  // The fixture's next read observes only the acknowledged profile write.
  await gateway.setMethodResponse("users.prefs.get", profilePreferences(sidebarEntries));
  await gateway.resolveDeferred("users.prefs.set", { status: "ok" });
}

suite.define(() => {
  it("pins from the row while its personal preference write is still in flight", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installPinGateway(page);

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, candidateKey));
      const pin = personalPin(page);
      const row = candidateRow(page);
      await row.waitFor();
      await expect.poll(() => storedPins(page)).toEqual([]);
      await expect.poll(() => pin.count()).toBe(0);
      await captureUiProof(suite, page, "optimistic-pin-01-before-click.png");

      await gateway.deferNext("users.prefs.set");
      await row.hover();
      await row.getByRole("button", { name: "Pin session", exact: true }).click();
      const write = await gateway.waitForRequest("users.prefs.set");
      expect(write.params).toEqual({
        entries: { [pinsKey]: [pinRef] },
        expectedEntries: { [pinsKey]: [] },
      });
      // Personal refs appear immediately, without removing the session from Sessions.
      await expect.poll(() => pin.count()).toBe(1);
      expect(await row.count()).toBe(1);
      await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
      await expect.poll(() => storedPins(page)).toEqual([pinRef]);
      expect(await pendingPinWrites(page)).toEqual([
        expect.objectContaining({ railShortcuts: [pinRef], railShortcutsBase: [] }),
      ]);
      await expectNoSharedPinWrites(gateway);
      await captureUiProof(suite, page, "optimistic-pin-02-pinned-while-in-flight.png");

      await confirmPinWrite(gateway, [pinRef]);
      await expect.poll(() => pendingPinWrites(page)).toEqual([]);
      expect(await pin.count()).toBe(1);
      expect(await row.count()).toBe(1);
      // Reconnect re-reads profile state rather than relying on a shared pinned flag.
      const beforeRead = (await gateway.getRequests("users.prefs.get")).length;
      await gateway.closeLatest(1001, "verify personal pin persistence");
      await gateway.waitForRequest("users.prefs.get", { after: beforeRead });
      await expect.poll(() => storedPins(page)).toEqual([pinRef]);
      await pin.getByRole("link", { name: "Pin me", exact: true }).waitFor();
      expect(await row.count()).toBe(1);
      await expectNoSharedPinWrites(gateway);
      await captureUiProof(suite, page, "optimistic-pin-03-confirmed-after-reconnect.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "optimistic-pin-button.webm"));
      }
    }
  });

  it("retains a personal menu unpin for replay when profile storage is unavailable", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installPinGateway(page, [pinRef]);

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, candidateKey));
      const pin = personalPin(page);
      const row = candidateRow(page);
      await expect.poll(() => pin.count()).toBe(1);
      await expect.poll(() => storedPins(page)).toEqual([pinRef]);
      await gateway.deferNext("users.prefs.set");
      await row.click({ button: "right" });
      await activateSelfRemovingControl(
        page
          .locator("openclaw-session-menu")
          .getByRole("menuitem", { name: "Unpin session", exact: true }),
      );
      const write = await gateway.waitForRequest("users.prefs.set");
      expect(write.params).toEqual({
        entries: { [pinsKey]: [] },
        expectedEntries: { [pinsKey]: [pinRef] },
      });
      await expect.poll(() => pin.count()).toBe(0);
      expect(await row.count()).toBe(1);
      await captureUiProof(suite, page, "optimistic-pin-04-unpinned-while-in-flight.png");

      // Preferences retain unsynced intent; shared-session rollback/error UI is not this owner.
      await gateway.rejectDeferred("users.prefs.set", {
        code: "UNAVAILABLE",
        message: "profile pin storage unavailable",
        retryable: true,
      });
      await expect.poll(() => storedPins(page)).toEqual([]);
      expect(await pendingPinWrites(page)).toEqual([
        expect.objectContaining({ railShortcuts: [], railShortcutsBase: [pinRef] }),
      ]);
      await gateway.deferNext("users.prefs.set");
      await gateway.closeLatest(1001, "retry personal unpin");
      const replay = await gateway.waitForRequest("users.prefs.set", { after: 1 });
      expect(replay.params).toEqual(write.params);
      expect(await pin.count()).toBe(0);
      await confirmPinWrite(gateway, []);
      await expect.poll(() => pendingPinWrites(page)).toEqual([]);
      expect(await pin.count()).toBe(0);
      expect(await row.count()).toBe(1);
      await expect.poll(() => storedPins(page)).toEqual([]);
      await expectNoSharedPinWrites(gateway);
      await captureUiProof(suite, page, "optimistic-pin-05-unpin-replayed.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the newest personal pin intent while the older preference write completes", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installPinGateway(page);

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, candidateKey));
      const pin = personalPin(page);
      const row = candidateRow(page);
      await row.waitFor();
      await expect.poll(() => storedPins(page)).toEqual([]);
      await gateway.deferNext("users.prefs.set");
      await row.hover();
      await row.getByRole("button", { name: "Pin session", exact: true }).click();
      const first = await gateway.waitForRequest("users.prefs.set");
      expect(first.params).toEqual({
        entries: { [pinsKey]: [pinRef] },
        expectedEntries: { [pinsKey]: [] },
      });
      await expect.poll(() => pin.count()).toBe(1);

      await gateway.deferNext("users.prefs.set");
      await row.getByRole("button", { name: "Unpin session", exact: true }).click();
      await expect.poll(() => pin.count()).toBe(0);
      await expect.poll(() => storedPins(page)).toEqual([]);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(1);

      await confirmPinWrite(gateway, [pinRef]);
      const second = await gateway.waitForRequest("users.prefs.set", { after: 1 });
      expect(second.params).toEqual({
        entries: { [pinsKey]: [] },
        expectedEntries: { [pinsKey]: [pinRef] },
      });
      expect(await pin.count()).toBe(0);
      expect(await row.count()).toBe(1);
      expect(await storedPins(page)).toEqual([]);

      await confirmPinWrite(gateway, []);
      await expect.poll(() => pendingPinWrites(page)).toEqual([]);
      expect(await pin.count()).toBe(0);
      expect(await storedPins(page)).toEqual([]);
      await expectNoSharedPinWrites(gateway);
      await captureUiProof(suite, page, "optimistic-pin-06-newest-intent-wins.png");
    } finally {
      await context.close();
    }
  });
});
