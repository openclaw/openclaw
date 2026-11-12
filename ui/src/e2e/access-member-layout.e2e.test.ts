import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Access confirmation layout" });
const longName = "Mira Example — integration review";
const names = [longName, "Bo", "Mira" + "LongIdentity".repeat(8)];

async function expectContained(surface: Locator) {
  const overflow = await surface.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          element.checkVisibility() &&
          box.width > 0 &&
          !element.closest(".ocid-access__sr-only") &&
          (box.left < bounds.left - 1 ||
            box.right > bounds.right + 1 ||
            (getComputedStyle(element).textOverflow !== "ellipsis" &&
              element.scrollWidth > element.clientWidth + 1))
        );
      })
      .map((element) => element.className || element.tagName);
  });
  expect(overflow).toEqual([]);
}

suite.define(() => {
  it("keeps full removal identities, warnings and Cancel inside the registered Access page", async () => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
        serviceWorkers: "block",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const gateway = await installNativePluginMockGateway(page, {
          nativePlugins: [
            {
              pluginId: "openclaw-id-access",
              rootDir: path.resolve("extensions/openclaw-id-access"),
              source: "./browser/index.tsx",
            },
          ],
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          methodResponses: {
            "openclawId.status": {
              status: { state: "on" },
              owner: true,
              channel: "local_operator",
              link: { linked: true },
            },
            "openclawId.people": { link: { linked: true } },
          },
        });
        await page.goto(suite.server.baseUrl + "plugin?plugin=openclaw-id-access&id=access");
        await page.locator(".ocid-access").waitFor();
        // Fresh non-extractable fixture key exercises owner readiness, never signing or removal.
        const devicePub = await page.evaluate(async () => {
          const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
          const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
          await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open("openclaw-id", 1);
            open.addEventListener("upgradeneeded", () =>
              open.result.createObjectStore("owner-devices"),
            );
            open.addEventListener("error", () =>
              reject(open.error ?? new Error("Could not open fixture key store")),
            );
            open.addEventListener("success", () => {
              const db = open.result;
              const tx = db.transaction("owner-devices", "readwrite");
              tx.objectStore("owner-devices").put(pair, "synthetic-claw");
              tx.addEventListener("complete", () => {
                db.close();
                resolve();
              });
              tx.addEventListener("error", () => {
                db.close();
                reject(tx.error ?? new Error("Could not store fixture key"));
              });
            });
          });
          return (
            "ed25519:" + Array.from(raw, (value) => value.toString(16).padStart(2, "0")).join("")
          );
        });
        const now = Math.floor(Date.now() / 1000);
        const link = {
          linked: true,
          clawId: "synthetic-claw",
          ownerDevices: [{ devicePub, label: "Synthetic browser", peerKeys: [], cert: {} }],
          roles: [
            {
              name: "operator",
              defined: true,
              sessions: "write",
              requiresSandbox: false,
              admin: false,
            },
            {
              name: "viewer",
              defined: true,
              sessions: "view",
              requiresSandbox: false,
              admin: false,
            },
            {
              name: "administrator",
              defined: true,
              sessions: "write",
              requiresSandbox: false,
              admin: true,
            },
            {
              name: "isolated",
              defined: true,
              sessions: "none",
              requiresSandbox: true,
              admin: false,
            },
          ],
          members: names.map((displayName, index) => ({
            accountId: "member-" + index,
            displayName,
            role: index === 1 ? "deleted-role" : "operator",
            roleDefined: index !== 1,
            peerKeys: [],
            email: "member-" + index + "@example.test",
          })),
          invites: [
            {
              inviteId: "open",
              label: "Pending teammate invitation",
              role: "viewer",
              status: "open",
              createdAt: now,
              expiresAt: now + 3600,
            },
            {
              inviteId: "pending",
              label: "Reviewer",
              role: "viewer",
              status: "pending",
              createdAt: now,
              expiresAt: now + 3600,
              pending: {
                accountId: "reviewer",
                devicePub: "ed25519:" + "b".repeat(64),
                peerKey: "iroh:reviewer",
                requestedAt: now,
                decideBy: now + 3600,
                reported: {
                  email: "review@example.test",
                  displayName: "Reviewer",
                  locationHint: "Test location",
                },
              },
            },
          ],
          nodes: [
            {
              peerKey: "iroh:" + "a".repeat(64),
              label: "Integration review workstation",
              description: { display_name: "Review workstation", platform: "linux" },
              addedBy: "root",
              lastSeen: now,
            },
          ],
        };
        await gateway.setMethodResponse("openclawId.people", { link });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        const surface = page.locator(".ocid-access");
        const member = page.locator(".ocid-access__row--member").first();
        await expect
          .poll(() => member.getByRole("button", { name: "Remove", exact: true }).isEnabled())
          .toBe(true);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.setViewportSize({ width: 1400, height: 1000 });
          const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
            animations: "disabled",
          });
          writeFileSync(path.join(suite.artifactDir, "access-overview.png"), frame.png);
        }
        await page.setViewportSize({ width: 1400, height: 1000 });
        const invite = page.locator('[aria-labelledby="ocid-access-invite"]');
        await invite
          .getByRole("textbox", { name: "Email address to invite" })
          .fill("review@example.test");
        await invite.locator(".ocid-access__role-picker button").click();
        const options = page.getByRole("option");
        expect(await options.allTextContents()).toEqual([
          expect.stringContaining("Operator"),
          expect.stringContaining("administrator"),
          expect.stringContaining("isolated"),
          expect.stringContaining("Viewer"),
        ]);
        expect(await options.nth(2).textContent()).toContain("Sandbox required");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, invite, [options.last()], {
            animations: "disabled",
          });
          writeFileSync(path.join(suite.artifactDir, "invite-role-list.png"), frame.png);
        }
        await page.getByRole("option", { name: /^administrator · Administrator access/ }).click();
        await invite.getByRole("button", { name: "Create invite link", exact: true }).click();
        const confirmAdmin = invite.getByRole("button", { name: "Confirm administrator invite" });
        await confirmAdmin.waitFor();
        expect(await invite.textContent()).toContain("change Gateway settings");
        expect(await gateway.getRequests("openclawId.authority")).toEqual([]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, invite, [confirmAdmin], {
            animations: "disabled",
          });
          writeFileSync(path.join(suite.artifactDir, "administrator-confirmation.png"), frame.png);
        }
        await invite.getByRole("button", { name: "Cancel", exact: true }).click();
        const blocked = page.locator(".ocid-access__row--member").filter({ hasText: "Bo" });
        expect(await blocked.textContent()).toContain(
          "The role deleted-role is not defined on this claw",
        );
        await blocked.getByRole("button", { name: "Change role", exact: true }).click();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            blocked,
            [blocked.getByRole("button", { name: "Save role" })],
            { animations: "disabled", scrollTo: blocked },
          );
          writeFileSync(path.join(suite.artifactDir, "blocked-member-change-role.png"), frame.png);
        }
        await blocked.getByRole("button", { name: "Cancel", exact: true }).click();
        const node = page.locator('[aria-labelledby="ocid-nodes"] .ocid-access__row').first();
        for (const width of [390, 820, 1400]) {
          await page.setViewportSize({ width, height: width === 390 ? 480 : 844 });
          await blocked.getByRole("button", { name: "Change role", exact: true }).click();
          await expectContained(surface);
          await blocked.getByRole("button", { name: "Save role" }).click({ trial: true });
          await blocked.getByRole("button", { name: "Cancel", exact: true }).click();
          await node.getByRole("button", { name: "Remove node", exact: true }).click();
          const nodeConfirm = node.getByRole("button", {
            name: "Remove Integration review workstation",
            exact: true,
          });
          await nodeConfirm.waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, node, [nodeConfirm], {
              animations: "disabled",
              scrollTo: nodeConfirm,
            });
            writeFileSync(
              path.join(suite.artifactDir, "node-confirmation-" + width + ".png"),
              frame.png,
            );
          }
          // Containment alone passes with a two-pixel warning column.
          expect((await node.getByRole("note").boundingBox())!.width).toBeGreaterThanOrEqual(200);
          expect(
            (await node.locator(".ocid-access__title").boundingBox())!.width,
          ).toBeGreaterThanOrEqual(200);
          expect(await node.getByRole("note").textContent()).toContain("deletes its node pairing");
          await expectContained(surface);
          await nodeConfirm.click({ trial: true });
          await node.getByRole("button", { name: "Cancel", exact: true }).click();
          const group = page.locator(".ocid-access__group");
          const before = (await group.boundingBox())!.width;
          for (const name of names) {
            const row = page.locator(".ocid-access__row--member").filter({ hasText: name });
            await row.getByRole("button", { name: "Remove", exact: true }).click();
            const confirm = row.getByRole("button", { name: "Remove " + name, exact: true });
            await confirm.waitFor();
            expect(await row.getByRole("note").textContent()).toContain(
              "Completed work and conversations stay here.",
            );
            expect((await group.boundingBox())!.width).toBe(before);
            await expectContained(surface);
            await confirm.click({ trial: true });
            await row.getByRole("button", { name: "Cancel", exact: true }).click();
            await confirm.waitFor({ state: "hidden" });
          }
        }
        await page.setViewportSize({ width: 390, height: 480 });
        await page
          .getByRole("textbox", { name: "Email address to invite" })
          .fill("review@example.test");
        await page.locator(".ocid-access__role-picker button").click();
        await page.getByRole("option", { name: "Viewer", exact: false }).click();
        await page
          .getByRole("button", { name: "Create invite link", exact: true })
          .click({ trial: true });
        await page.getByText("Request details", { exact: true }).click();
        await expectContained(surface);
        await gateway.setOperatorScopes(["operator.read", "operator.write"]);
        await gateway.closeLatest();
        await expect
          .poll(() => node.getByRole("button", { name: "Remove node", exact: true }).isDisabled())
          .toBe(true);
        await expectContained(surface);
        await gateway.setMethodResponse("openclawId.people", {
          link: { ...link, ownerDevices: [] },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        await expect
          .poll(() => surface.getByRole("button", { name: "Remove", exact: true }).count())
          .toBe(0);
        await expectContained(surface);
        expect(await gateway.getRequests("openclawId.authority")).toEqual([]);
      },
    );
  });
});
