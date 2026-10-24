import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
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

const storedPins = (page: Page) =>
  page.evaluate(
    ({ key, profile }) =>
      JSON.parse(localStorage.getItem(key) ?? "{}").navigationByProfile?.[profile]?.railShortcuts,
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), profile: profileId },
  );

const pendingPinWrites = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("openclaw.control.serverPrefs.pending.v1:"))
      .map((key) => JSON.parse(localStorage.getItem(key) ?? "null"))
      .filter((value) => value && Object.hasOwn(value, "railShortcuts")),
  );

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

type PinFixture = { page: Page; gateway: MockGatewayControls; pin: Locator; row: Locator };
function withPins(run: (fixture: PinFixture) => Promise<void>, initial: string[] = []) {
  return suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
    const owner = { actor: { type: "human", id: profileId, label: "Pin owner" } };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        // Profile hydration waits for the runtime configuration snapshot, not just presence.
        "config.get": { config: {}, hash: "pin-profile-config" },
        "sessions.list": sessionsListResponse([
          sessionRow(candidateKey, "Pin me", baseTime, { owner }),
          sessionRow(companionKey, "Stay put", baseTime - 1_000, { owner }),
        ]),
        "users.prefs.get": profilePreferences(initial),
        "users.prefs.set": { status: "ok" },
      },
      featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
      presenceUsers: [{ self: true, id: profileId, name: "Pin owner" }],
      sessionKey: candidateKey,
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, candidateKey));
    await run({
      page,
      gateway,
      pin: page.locator(
        `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${candidateKey}"]`,
      ),
      row: page.locator(
        `.sidebar-session-content .sidebar-recent-session[data-session-key="${candidateKey}"]`,
      ),
    });
  });
}
const pinWrite = (entries: string[], expected: string[]) => ({
  entries: { [pinsKey]: entries },
  expectedEntries: { [pinsKey]: expected },
});

suite.define(() => {
  it.each(["reconnect", "newer unpin"] as const)("keeps personal pin state through %s", (outcome) =>
    withPins(async ({ page, gateway, pin, row }) => {
      await row.waitFor();
      await expect.poll(() => storedPins(page)).toEqual([]);
      await expect.poll(() => pin.count()).toBe(0);
      await gateway.deferNext("users.prefs.set");
      await row.hover();
      await row.getByRole("button", { name: "Pin session", exact: true }).click();
      const write = await gateway.waitForRequest("users.prefs.set");
      expect(write.params).toEqual(pinWrite([pinRef], []));
      await expect.poll(() => pin.count()).toBe(1);
      if (outcome === "reconnect") {
        expect(await row.count()).toBe(1);
        await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
        await expect.poll(() => storedPins(page)).toEqual([pinRef]);
        expect(await pendingPinWrites(page)).toEqual([
          expect.objectContaining({ railShortcuts: [pinRef], railShortcutsBase: [] }),
        ]);
        await expectNoSharedPinWrites(gateway);

        await confirmPinWrite(gateway, [pinRef]);
        await expect.poll(() => pendingPinWrites(page)).toEqual([]);
        expect(await pin.count()).toBe(1);
        expect(await row.count()).toBe(1);
        // Reconnect re-reads profile state rather than relying on a shared pinned flag.
        const beforeRead = (await gateway.getRequests("users.prefs.get")).length;
        await gateway.closeLatest(1001, "verify personal pin persistence");
        await gateway.waitForRequest("users.prefs.get", { after: beforeRead });
        await expect.poll(() => storedPins(page)).toEqual([pinRef]);
        await pin.getByText("Pin me", { exact: true }).waitFor();
        expect(await row.count()).toBe(1);
        await expectNoSharedPinWrites(gateway);
      } else {
        await gateway.deferNext("users.prefs.set");
        // Pinning moves the row into Pinned, so reveal its actions again.
        await row.hover();
        await row.getByRole("button", { name: "Unpin session", exact: true }).click();
        await expect.poll(() => pin.count()).toBe(0);
        await expect.poll(() => storedPins(page)).toEqual([]);
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(1);

        await confirmPinWrite(gateway, [pinRef]);
        const second = await gateway.waitForRequest("users.prefs.set", { after: 1 });
        expect(second.params).toEqual(pinWrite([], [pinRef]));
        expect(await pin.count()).toBe(0);
        expect(await row.count()).toBe(1);
        expect(await storedPins(page)).toEqual([]);

        await confirmPinWrite(gateway, []);
        await expect.poll(() => pendingPinWrites(page)).toEqual([]);
        expect(await pin.count()).toBe(0);
        expect(await storedPins(page)).toEqual([]);
        await expectNoSharedPinWrites(gateway);
      }
    }),
  );

  it("retains a personal menu unpin for replay when profile storage is unavailable", () =>
    withPins(
      async ({ page, gateway, pin, row }) => {
        await expect.poll(() => pin.count()).toBe(1);
        await expect.poll(() => storedPins(page)).toEqual([pinRef]);
        await gateway.deferNext("users.prefs.set");
        await row.click({ button: "right" });
        await page
          .locator("openclaw-session-menu")
          .getByRole("menuitem", { name: "Unpin session", exact: true })
          .click();
        const write = await gateway.waitForRequest("users.prefs.set");
        expect(write.params).toEqual(pinWrite([], [pinRef]));
        await expect.poll(() => pin.count()).toBe(0);
        expect(await row.count()).toBe(1);

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
      },
      [pinRef],
    ));
});
