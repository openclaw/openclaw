import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Access member confirmation layout" });
const longName = "Mira Example — integration review";

async function expectContained(surface: Locator) {
  const overflow = await surface.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          element.checkVisibility() &&
          box.width > 0 &&
          (box.left < bounds.left - 1 ||
            box.right > bounds.right + 1 ||
            element.scrollWidth > element.clientWidth + 1)
        );
      })
      .map((element) => element.className || element.tagName);
  });
  expect(overflow).toEqual([]);
}

suite.define(() => {
  it("keeps full removal identities, warnings and Cancel inside the registered Access page", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, colorScheme: "dark", serviceWorkers: "block" },
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
          members: [longName, "Bo"].map((displayName, index) => ({
            accountId: "member-" + index,
            displayName,
            role: "operator",
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
        for (const width of [390, 820, 1400]) {
          await page.setViewportSize({ width, height: 844 });
          const group = page.locator(".ocid-access__group");
          const before = (await group.boundingBox())!.width;
          for (const name of [longName, "Bo"]) {
            const row = page.locator(".ocid-access__row--member").filter({ hasText: name });
            await row.getByRole("button", { name: "Remove", exact: true }).click();
            const confirm = row.getByRole("button", { name: "Remove " + name, exact: true });
            await confirm.waitFor();
            expect(await row.getByRole("note").textContent()).toContain(
              "Completed work and conversations stay here.",
            );
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && name === longName) {
              const frame = await takeControlUiScreenshotFrame(page, row, [confirm], {
                animations: "disabled",
                scrollTo: row,
              });
              writeFileSync(
                path.join(suite.artifactDir, "confirmation-" + width + ".png"),
                frame.png,
              );
            }
            expect((await group.boundingBox())!.width).toBe(before);
            await expectContained(surface);
            await confirm.click({ trial: true });
            await row.getByRole("button", { name: "Cancel", exact: true }).click();
            await confirm.waitFor({ state: "hidden" });
          }
        }
        await page.setViewportSize({ width: 390, height: 480 });
        const node = page.locator('[aria-labelledby="ocid-nodes"] .ocid-access__row').first();
        await node.getByRole("button", { name: "Remove node", exact: true }).click();
        await expectContained(surface);
        await node
          .getByRole("button", { name: "Remove Integration review workstation", exact: true })
          .click({ trial: true });
        await node.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("textbox", { name: "Email address to invite" })
          .fill("review@example.test");
        await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("viewer");
        await page
          .getByRole("button", { name: "Create invite link", exact: true })
          .click({ trial: true });
        await page.getByText("Request details", { exact: true }).click();
        await expectContained(surface);
        await member.getByRole("button", { name: "Remove", exact: true }).click();
        const confirmation = member.getByRole("button", {
          name: "Remove " + longName,
          exact: true,
        });
        await confirmation.click({ trial: true });
        const unbroken = "Mira" + "LongIdentity".repeat(8);
        await gateway.setMethodResponse("openclawId.people", {
          link: {
            ...link,
            members: [{ ...link.members[0], displayName: unbroken }, link.members[1]],
          },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        const unbrokenConfirm = member.getByRole("button", {
          name: "Remove " + unbroken,
          exact: true,
        });
        await unbrokenConfirm.waitFor();
        await expectContained(surface);
        await unbrokenConfirm.click({ trial: true });
        await gateway.setMethodResponse("openclawId.people", {
          link: {
            ...link,
            members: [{ ...link.members[0], displayName: unbroken }, link.members[1]],
            ownerDevices: [],
          },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        await expect.poll(() => unbrokenConfirm.isDisabled()).toBe(true);
        await expectContained(surface);
        await member.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await gateway.getRequests("openclawId.authority")).toEqual([]);
      },
    );
  });
});
