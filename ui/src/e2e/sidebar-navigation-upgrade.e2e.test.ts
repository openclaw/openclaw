import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Stable navigation preference upgrade" });

suite.define(() => {
  it.each([false, true])(
    "imports stable navigation without overwriting an explicit-empty profile (%s)",
    async (hasProfilePins) => {
      await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
        const key = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        // v2026.9.9 (bcfc88812a35), ui/src/app/settings.ts saveSettings:
        // top-level sidebarEntries in the Gateway-scoped v1 record; no navigationScope.
        const stable = {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          sidebarEntries: ["route:usage", "route:cron"],
          theme: "claw",
          themeMode: "dark",
          navWidth: 333,
          textScale: 110,
          realtimeTalkInputDeviceId: "synthetic-microphone",
          pinnedAgentIds: ["research"],
        };
        await page.addInitScript(
          ({ key: storageKey, stable: persisted }) =>
            localStorage.setItem(storageKey, JSON.stringify(persisted)),
          { key, stable },
        );
        const migrated = ["route:systems", "route:usage", "session:agent:main:legacy-plan"];
        const appearance = { "ui.themeMode": "dark" };
        const finalEntries = { ...appearance, "ui.sidebarEntries": hasProfilePins ? [] : migrated };
        const legacySession = {
          key: "agent:main:legacy-plan",
          kind: "direct" as const,
          label: "Planning",
          pinned: true,
          owner: { actor: { type: "human" as const, id: "alex", label: "Alex" } },
        };
        const gateway = await installMockGateway(page, {
          heldMethods: ["connect"],
          sessions: [legacySession],
          presenceUsers: [{ id: "alex", name: "Alex", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { pinned: true },
                  response: {
                    ts: 1,
                    path: "",
                    defaults: {},
                    count: 1,
                    totalCount: 1,
                    offset: 0,
                    hasMore: false,
                    nextOffset: null,
                    sessions: [legacySession],
                  },
                },
              ],
            },
            "config.get": {
              config: { ui: { prefs: { sidebarEntries: ["route:systems", "route:usage"] } } },
              hash: "legacy-navigation",
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("connect");
        // One wire fixture owns preference state regardless of concurrent read order.
        await page.evaluate(
          (initial) => {
            const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
            const values: Record<string, unknown> = { ...initial };
            mock.setRequestHandler("users.prefs.get", ({ respond }) =>
              respond({ status: "ok", entries: values }),
            );
            mock.setRequestHandler("users.prefs.set", ({ params, respond }) => {
              if (
                !params ||
                typeof params !== "object" ||
                !("entries" in params) ||
                !params.entries ||
                typeof params.entries !== "object"
              ) {
                throw new Error("Expected profile preference entries");
              }
              Object.assign(values, params.entries);
              respond({ status: "ok" });
            });
          },
          hasProfilePins ? finalEntries : appearance,
        );
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("users.prefs.get");
        if (!hasProfilePins) {
          const migration = await gateway.waitForRequest("users.prefs.set");
          expect(migration.params).toEqual({
            entries: { "ui.sidebarEntries": migrated },
            expectedEntries: { "ui.sidebarEntries": null },
          });
        }
        const pins = page.locator("openclaw-app-sidebar .sidebar-rail__pin");
        await expect
          .poll(() =>
            pins.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
          )
          .toEqual(hasProfilePins ? [] : migrated);
        const writes = await gateway.getRequests("users.prefs.set");
        if (hasProfilePins) {
          expect(writes).toEqual([]);
          expect(await gateway.getRequests("sessions.list", { pinned: true })).toEqual([]);
        } else {
          expect(writes).toHaveLength(1);
          expect(writes[0]!.params).toEqual({
            entries: { "ui.sidebarEntries": migrated },
            expectedEntries: { "ui.sidebarEntries": null },
          });
          expect(await gateway.getRequests("sessions.list", { pinned: true })).toHaveLength(1);
        }
        expect(
          await page.evaluate(
            (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
            key,
          ),
        ).toMatchObject({
          theme: stable.theme,
          themeMode: stable.themeMode,
          navWidth: stable.navWidth,
          textScale: stable.textScale,
          realtimeTalkInputDeviceId: stable.realtimeTalkInputDeviceId,
          pinnedAgentIds: stable.pinnedAgentIds,
        });
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      });
    },
  );
});
