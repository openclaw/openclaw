import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPinMenu } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Stable navigation preference upgrade" });

suite.define(() => {
  it.each([false, true])(
    "keeps an uncustomized profile clean without importing legacy navigation (%s)",
    async (hasProfilePins) => {
      await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
        const key = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const stable = {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
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
        const appearance = { "ui.themeMode": "dark" };
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
          hasProfilePins ? { ...appearance, "ui.sidebarEntries": [] } : appearance,
        );
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("users.prefs.get");
        await page.locator('[data-session-key="agent:main:legacy-plan"]').waitFor();
        const pins = page.locator("openclaw-app-sidebar .sidebar-rail__pin");
        await expect
          .poll(() =>
            pins.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
          )
          .toEqual([]);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        expect(await gateway.getRequests("sessions.list", { pinned: true })).toEqual([]);
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

  it.each(["recorded", "missing", "corrupt", "fresh-confirmed"] as const)(
    "replays v2026.9.9 pending shortcuts without stranding appearance (baseline=%s)",
    async (baseline) => {
      const hasBaseline = baseline === "recorded";
      await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
        const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
        const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const scope = gatewayUrl + ":profile:alex";
        const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope;
        const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope;
        const desired = ["route:plugins"];
        const remote = ["route:usage", "route:cron"];
        await page.addInitScript(
          ({
            gatewayUrl: targetGatewayUrl,
            storageKey: settingsStorageKey,
            pendingKey: pendingStorageKey,
            lastSeenKey: confirmedStorageKey,
            baseline: baselineKind,
            desired: localPins,
          }) => {
            if (sessionStorage.getItem("stable-outbox-seeded")) {
              return;
            }
            sessionStorage.setItem("stable-outbox-seeded", "true");
            // Literal persisted outputs from v2026.9.9: no sidebarEntriesBase field.
            localStorage.setItem(
              settingsStorageKey,
              JSON.stringify({
                gatewayUrl: targetGatewayUrl,
                sidebarEntries: localPins,
                theme: "claw",
                themeMode: "dark",
                accent: "#ff0000",
              }),
            );
            localStorage.setItem(
              pendingStorageKey,
              JSON.stringify({ sidebarEntries: localPins, accent: "#ff0000" }),
            );
            if (baselineKind === "recorded") {
              localStorage.setItem(
                confirmedStorageKey,
                JSON.stringify({ sidebarEntries: ["route:usage"] }),
              );
            }
            if (baselineKind === "corrupt") {
              localStorage.setItem(confirmedStorageKey, "{");
            }
            if (baselineKind === "fresh-confirmed") {
              localStorage.setItem(
                confirmedStorageKey,
                JSON.stringify({
                  sidebarEntries: ["route:usage", "route:cron"],
                  navigationConfirmation: { sidebarEntries: "fresh-read" },
                }),
              );
            }
          },
          { gatewayUrl, storageKey, pendingKey, lastSeenKey, baseline, desired },
        );
        const gateway = await installMockGateway(page, {
          heldMethods: ["connect"],
          presenceUsers: [{ id: "alex", name: "Alex", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          methodResponses: {
            "config.get": { config: { ui: { prefs: {} } }, hash: "stable-outbox-upgrade" },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("connect");
        const installPreferences = (initial: Record<string, unknown>) =>
          page.evaluate((initialValues) => {
            const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
            const values: Record<string, unknown> = { ...initialValues };
            mock.setRequestHandler("users.prefs.get", ({ respond }) =>
              respond({ status: "ok", entries: values }),
            );
            mock.setRequestHandler("users.prefs.set", ({ params, respond }) => {
              const request = params as {
                entries: Record<string, unknown>;
                expectedEntries?: Record<string, unknown>;
              };
              if (
                Object.entries(request.expectedEntries ?? {}).some(
                  ([key, value]) => JSON.stringify(values[key] ?? null) !== JSON.stringify(value),
                )
              ) {
                respond({ status: "conflict" });
                return;
              }
              Object.assign(values, request.entries);
              respond({ status: "ok" });
            });
          }, initial);
        await installPreferences({ "ui.sidebarEntries": remote, "ui.themeMode": "dark" });
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("users.prefs.get");
        const pins = page.locator("openclaw-app-sidebar .sidebar-rail__pin");
        if (!hasBaseline) {
          await expect
            .poll(() =>
              pins.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
            )
            .toEqual(desired);
        }
        await expect
          .poll(async () =>
            (await gateway.getRequests("users.prefs.set")).map((request) => request.params),
          )
          .toEqual([
            ...(hasBaseline
              ? [
                  {
                    entries: { "ui.sidebarEntries": ["route:cron", "route:plugins"] },
                    expectedEntries: { "ui.sidebarEntries": remote },
                  },
                ]
              : []),
            { entries: { "ui.accent": "#ff0000" } },
          ]);
        await expect
          .poll(() =>
            pins.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
          )
          .toEqual(hasBaseline ? ["route:cron", "route:plugins"] : desired);
        expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
        if (!hasBaseline) {
          const recovery = page.getByText(
            "Shortcuts are saved only on this device because their previous sync state is missing. Edit a shortcut to sync again.",
            { exact: true },
          );
          await recovery.waitFor();
          if (baseline === "missing" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [pins.first(), recovery],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, "missing-baseline.png"), frame.png);
          }
        }
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        await page.reload();
        await gateway.waitForRequest("connect");
        const savedPins = hasBaseline ? ["route:cron", "route:plugins"] : remote;
        await installPreferences({
          "ui.sidebarEntries": savedPins,
          "ui.accent": "#ff0000",
          "ui.themeMode": "dark",
        });
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("users.prefs.get");
        await expect
          .poll(() =>
            pins.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
          )
          .toEqual(hasBaseline ? savedPins : desired);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        if (!hasBaseline) {
          const menu = await openSidebarPinMenu(page, "route:plugins");
          await menu.getByRole("menuitem", { name: "Unpin", exact: true }).click();
          const recoveryWrite = await gateway.waitForRequest("users.prefs.set");
          expect(recoveryWrite.params).toEqual({
            entries: { "ui.sidebarEntries": remote },
            expectedEntries: { "ui.sidebarEntries": remote },
          });
          await expect
            .poll(() => page.evaluate((key) => localStorage.getItem(key), pendingKey))
            .toBeNull();
        }
      });
    },
  );
});
