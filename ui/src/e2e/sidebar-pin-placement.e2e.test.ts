import { expect, it } from "vitest";
import {
  CHAT_SNAPSHOT_DB_NAME,
  SIDEBAR_SNAPSHOT_STORE_NAME,
} from "../pages/chat/session-snapshot-database.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:reliability";

suite.define(() => {
  it.for([
    { scope: "operator.admin", offPage: false },
    { scope: "operator.sessions.read", offPage: false },
    { scope: "operator.sessions.read", offPage: true },
  ])(
    "reorders personal pins without changing rail shortcuts or shared groups ($scope; off-page: $offPage)",
    async ({ scope, offPage }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const keys = [key, "agent:main:release", "agent:main:research"];
        const pins = keys.map((sessionKey, index) =>
          createControlUiSessionRow(
            sessionKey,
            ["Reliability Tracker", "Release checklist", "Research notes"][index]!,
            Date.now() - index * 1000,
          ),
        );
        const selected = offPage
          ? createControlUiSessionRow("agent:main:selected", "Selected chat", Date.now())
          : pins[0]!;
        const gateway = await installMockGateway(page, {
          sessionKey: selected.key,
          operatorScopes: [scope],
          sessions: offPage ? [selected, ...pins] : pins,
          methodResponses: {
            "sessions.list": sessionsListResponse(offPage ? [selected] : pins),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected.key));
        if (offPage) {
          // Seed saved references through their owner; their rows are absent from sessions.list.
          await evaluateControlUiContext(
            page,
            ({ navigation }, entries) => navigation.update({ sidebarEntries: entries }),
            keys.map((sessionKey) => `session:${sessionKey}`),
          );
        }
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = (sessionKey: string) =>
          sidebar.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        if (!offPage) {
          for (const sessionKey of keys) {
            await row(sessionKey).hover();
            await row(sessionKey).getByRole("button", { name: "Pin session", exact: true }).click();
            await row(sessionKey)
              .getByRole("button", { name: "Unpin session", exact: true })
              .waitFor();
          }
        }
        const pinned = sidebar.locator('[data-session-section="pinned"]');
        const pinOrder = () =>
          pinned
            .locator(".sidebar-recent-session")
            .evaluateAll((rows) => rows.map((element) => element.getAttribute("data-session-key")));
        await expect.poll(pinOrder).toEqual(keys);
        const rail = sidebar.locator(".sidebar-rail__pins");
        await row(key).dragTo(rail);
        const shortcut = rail.locator(`[data-sidebar-entry="session-rail:${key}"]`);
        await shortcut.waitFor();
        await row(keys[2]!).dragTo(row(key), { targetPosition: { x: 80, y: 4 } });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const dir = createControlUiE2eArtifactDir(
            "pin-reorder",
            process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
          );
          await captureFrame(
            dir,
            process.env.OPENCLAW_PIN_PROOF_STAGE + "-" + scope + ".png",
            page.locator(".shell"),
            [pinned, sidebar.locator(".sidebar-rail")],
          );
          console.log("Pin reorder proof: " + dir);
        }
        await expect.poll(pinOrder).toEqual([keys[2], key, keys[1]]);
        const target = row(keys[1]!);
        const height = await target.evaluate((element) => element.getBoundingClientRect().height);
        await row(key).dragTo(target, { targetPosition: { x: 80, y: height - 4 } });
        const expected = [keys[2], keys[1], key];
        await expect.poll(pinOrder).toEqual(expected);
        // Dropping on itself must not bubble to a container and append the pin.
        await row(keys[2]!).dragTo(row(keys[2]!), { targetPosition: { x: 80, y: 4 } });
        expect(await pinOrder()).toEqual(expected);
        await page.reload();
        await expect.poll(pinOrder).toEqual(expected);
        expect(await shortcut.count()).toBe(1);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
      });
    },
  );
  it.for(["operator.admin", "operator.read"])(
    "personal pins and rail drags (%s)",
    async (scope) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          operatorScopes: [scope],
          methodResponses: {
            "sessions.list": sessionsListResponse([
              createControlUiSessionRow(key, "Reliability Tracker", Date.now(), { icon: "🛠️" }),
              createControlUiSessionRow(
                "agent:main:release",
                "Release checklist",
                Date.now() - 1000,
                { icon: "🚀" },
              ),
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await row.waitFor();
        await row.hover();
        await row.getByRole("button", { name: "Pin session", exact: true }).click();
        await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
        const pinned = sidebar.locator('[data-session-section="pinned"]');
        await expect
          .poll(() => pinned.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count())
          .toBe(1);
        const rail = sidebar.locator(".sidebar-rail__pins");
        expect(await rail.locator(".sidebar-rail__pin").count()).toBe(0);
        await row.locator("a.sidebar-recent-session__link").click({ modifiers: ["Alt"] });
        await pinned.locator(".sidebar-session-group-toggle").click();
        const plain = sidebar.locator(
          '.sidebar-recent-session[data-session-key="agent:main:release"]',
        );
        await plain.locator("a.sidebar-recent-session__link").click({ modifiers: ["Shift"] });
        await pinned.locator(".sidebar-session-group-toggle").click();
        expect(
          await row.evaluate((element) =>
            element.classList.contains("sidebar-recent-session--selected"),
          ),
        ).toBe(false);
        expect(
          await plain.evaluate((element) =>
            element.classList.contains("sidebar-recent-session--selected"),
          ),
        ).toBe(true);
        await plain.locator("a.sidebar-recent-session__link").click();
        await row.dragTo(rail);
        const shortcut = rail.locator('[data-sidebar-entry="session-rail:' + key + '"]');
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const dir = createControlUiE2eArtifactDir(
            "pin-placement",
            process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
          );
          await captureFrame(
            dir,
            process.env.OPENCLAW_PIN_PROOF_STAGE + "-" + scope + ".png",
            page.locator(".shell"),
            [row, sidebar.locator(".sidebar-rail")],
          );
          console.log("Pin placement proof: " + dir);
        }
        await expect.poll(() => shortcut.count()).toBe(1);
        await pinned.locator(".sidebar-session-group-toggle").click();
        await expect
          .poll(() =>
            page.evaluate(
              ({ databaseName, storeName }) =>
                new Promise<boolean>((resolve, reject) => {
                  const open = indexedDB.open(databaseName);
                  open.addEventListener("error", () =>
                    reject(open.error ?? new Error("Sidebar snapshot open failed")),
                  );
                  open.addEventListener("success", () => {
                    const database = open.result;
                    const transaction = database.transaction(storeName, "readonly");
                    const request = transaction.objectStore(storeName).getAll();
                    transaction.addEventListener("complete", () => {
                      database.close();
                      resolve(
                        request.result.some((record) =>
                          record.model.collapsedSections.includes("pinned"),
                        ),
                      );
                    });
                    transaction.addEventListener("abort", () => {
                      database.close();
                      reject(transaction.error ?? new Error("Sidebar snapshot read failed"));
                    });
                  });
                }),
              { databaseName: CHAT_SNAPSHOT_DB_NAME, storeName: SIDEBAR_SNAPSHOT_STORE_NAME },
            ),
          )
          .toBe(true);
        await page.reload();
        await shortcut.waitFor();
        await pinned.locator('.sidebar-session-group-toggle[aria-expanded="false"]').waitFor();
        await pinned.locator(".sidebar-session-group-toggle").click();
        await row.waitFor();
        expect(
          await pinned.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count(),
        ).toBe(1);
        await shortcut.click({ button: "right" });
        await sidebar.locator('.sidebar-rail-pin-menu [data-value="remove"]').click();
        await expect.poll(() => shortcut.count()).toBe(0);
        expect(
          await pinned.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count(),
        ).toBe(1);
        await row.dragTo(rail);
        await shortcut.waitFor();
        await row.hover();
        await row.getByRole("button", { name: "Unpin session", exact: true }).click();
        await expect.poll(() => pinned.count()).toBe(0);
        expect(await shortcut.count()).toBe(1);
        expect(await row.count()).toBe(1);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      });
    },
  );
});
