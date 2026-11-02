import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { evaluateControlUiContext } from "../../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI team secrets mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

function entry(name: string, content: string | string[]): SecretStoreEntry {
  return {
    name,
    scopeKind: "team",
    scopeId: "",
    createdAtMs: 1_786_352_400_000,
    updatedAtMs: 1_786_352_400_000,
    ...(typeof content === "string"
      ? { kind: "env", value: content }
      : { kind: "secret", allowedHosts: content }),
  };
}
const envEntry = entry("SERVICE_URL", "https://service.test");
const secretEntry = entry("SERVICE_API_KEY", ["api.example.com"]);
const longNameSecretEntry = {
  ...secretEntry,
  name: "REUTERS_OUTLOOK_CALENDAR_ICS_PRODUCTION_ACCESS_TOKEN",
};

async function tableBodyContrast(page: Page): Promise<number> {
  return await page
    .locator(".secrets-store__value")
    .first()
    .evaluate((element) => {
      const parse = (value: string) =>
        (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map((channel) => Number(channel) / 255);
      const luminance = (channels: number[]) =>
        channels.reduce((sum, channel, index) => {
          const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
        }, 0);
      const group = element.closest(".settings-group");
      if (!group) {
        throw new Error("Missing settings group for contrast measurement");
      }
      const foreground = luminance(parse(getComputedStyle(element).color));
      const background = luminance(parse(getComputedStyle(group).backgroundColor));
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
}

const gatewayIdentity = (page: Page) =>
  evaluateControlUiContext(page, ({ gateway }) => ({
    clientInstanceId: gateway.snapshot.client?.instanceId,
    gatewayUrl: gateway.connection.gatewayUrl,
    phase: gateway.snapshot.phase,
  }));

const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const field = (scope: Locator, name: string) => scope.getByLabel(name, { exact: true });
const bulkValue = (scope: Locator) => scope.getByRole("textbox", { name: "Value", exact: true });
const modal = (page: Page, label: string) =>
  page.locator(`openclaw-modal-dialog[label="${label}"]`);
const notice = (page: Page, text: string | RegExp) =>
  page.getByRole("status").getByText(text).waitFor();
const openSecrets = (page: Page) => page.goto(`${suite.server.baseUrl}settings/secrets`);
const saved = { ok: true, reloaded: false };

async function openStore(
  page: Page,
  responses: { list: unknown; set?: unknown; delete?: unknown },
  advertisedOnly: string[] = [],
) {
  const methodResponses = Object.fromEntries(
    Object.entries(responses).map(([method, response]) => [`secrets.store.${method}`, response]),
  );
  const gateway = await installMockGateway(page, {
    featureMethods: [...Object.keys(methodResponses), ...advertisedOnly],
    methodResponses,
  });
  await openSecrets(page);
  return gateway;
}

async function openDialog(page: Page, label: string) {
  await button(page, label).click();
  return modal(page, label);
}

async function rowAction(page: Page, name: string, action: "edit" | "delete") {
  const row = page.getByRole("row", { name: new RegExp(name, "u") });
  await button(row, `Actions: ${name}`).click();
  await row.locator(`.oc-menu-item[data-value="${action}"]`).click();
  return row;
}

suite.define(() => {
  it.each([false, true])("keeps narrow row actions visible (touch: %s)", async (hasTouch) => {
    await suite.withPage({ viewport: { width: 1000, height: 900 }, hasTouch }, async ({ page }) => {
      await openStore(page, { list: { entries: [secretEntry] } }, [
        "secrets.store.set",
        "secrets.store.delete",
      ]);
      const row = page.getByRole("row", { name: secretEntry.name });
      const trigger = row.getByRole("button", { name: `Actions: ${secretEntry.name}` });
      await trigger.waitFor({ state: "visible" });
      await row.hover();
      await page.evaluate(() => document.fonts.ready);
      const [buttonBox, tableBox] = await Promise.all([
        trigger.boundingBox(),
        page.locator(".secrets-store__table-wrap").boundingBox(),
      ]);
      if (!buttonBox || !tableBox) {
        throw new Error("Expected row actions and table to have layout boxes");
      }
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width);
    });
  });

  it.each([
    { width: 1440, height: 900, phone: false },
    { width: 390, height: 844, phone: true },
  ])("contains long secret names (phone: $phone)", async ({ width, height, phone }) => {
    await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
      await openStore(page, { list: { entries: [longNameSecretEntry] } });
      const row = page.getByRole("row", { name: longNameSecretEntry.name });
      const name = row.locator(".secrets-store__name");
      if (phone) {
        expect(await name.textContent()).toBe(longNameSecretEntry.name);
      } else {
        expect(await name.getAttribute("title")).toBe(longNameSecretEntry.name);
        const [nameBox, accessBox] = await Promise.all([
          name.boundingBox(),
          row.locator(".secrets-store__mode").boundingBox(),
        ]);
        if (!nameBox || !accessBox) {
          throw new Error("Expected Name and Access cells to have layout boxes");
        }
        expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(accessBox.x);
      }
      const layout = await name.evaluate((element) => {
        const style = getComputedStyle(element);
        const text = document.createRange();
        text.selectNodeContents(element);
        return {
          overflowX: style.overflowX,
          textOverflow: style.textOverflow,
          overflowWrap: style.overflowWrap,
          whiteSpace: style.whiteSpace,
          fitsHorizontally: element.scrollWidth <= element.clientWidth,
          wraps: text.getClientRects().length > 1,
        };
      });
      expect(layout).toMatchObject(
        phone
          ? { overflowWrap: "anywhere", whiteSpace: "normal", fitsHorizontally: true, wraps: true }
          : {
              overflowX: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fitsHorizontally: false,
            },
      );
      if (phone) {
        for (const selector of ["html", ".secrets-store__table-wrap", ".secrets-store__table"]) {
          const fits = await page.locator(selector).evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              element.scrollWidth <= element.clientWidth &&
              box.left >= 0 &&
              box.right <= window.innerWidth
            );
          });
          expect(fits, `${selector} stays inside the phone viewport`).toBe(true);
        }
      }
    });
  });

  it("validates and saves protected, environment, and mixed bulk entries", async () => {
    await suite.withPage({ colorScheme: "dark" }, async ({ page }) => {
      const gateway = await openStore(page, {
        list: { entries: [envEntry, secretEntry] },
        set: { sequence: [{ ok: true, reloaded: true, warningCount: 2 }, saved, saved, saved] },
      });
      expect(await tableBodyContrast(page)).toBeGreaterThanOrEqual(9.5);

      async function reject(dialog: Locator, text = "Enter a value.") {
        // Complete the modal's opening transition before submitting its form.
        await dialog.locator('dialog[data-phase="open"]').waitFor();
        await button(dialog, "Save").click();
        await dialog.getByRole("alert").getByText(text).waitFor();
        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
        await button(dialog, "Cancel").click();
      }
      await rowAction(page, "SERVICE_API_KEY", "edit");
      await reject(modal(page, "Edit"));

      const protectedBulk = await openDialog(page, "Bulk Add");
      await bulkValue(protectedBulk).fill("EMPTY_API_KEY=\nEMPTY_ENV=");
      await protectedBulk.getByText("1 protected secret detected").waitFor();
      await reject(protectedBulk, "EMPTY_API_KEY: Enter a value.");

      const secret = await openDialog(page, "Add");
      await field(secret, "Name").fill("SERVICE_API_KEY");
      await field(secret, "Value").fill("super-secret-material");
      await secret.locator('textarea[name="allowed-hosts"]').fill("api.example.com");
      await field(secret, "Name").press("Enter");
      await notice(
        page,
        "Saved SERVICE_API_KEY as Protected secret. Add a SecretRef or enable destination-bound Gateway egress to use it. 2 runtime warnings.",
      );
      expect(await page.content()).not.toContain("super-secret-material");

      const addEnv = await openDialog(page, "Add");
      await field(addEnv, "Name").fill("EMPTY_ENV");
      await addEnv.getByText(/The agent can print, transmit, or persist it/u).waitFor();
      await button(addEnv, "Save").click();
      await notice(
        page,
        "Saved EMPTY_ENV as Agent-readable environment. It is available to Gateway-hosted agent commands from the next run.",
      );

      const envBulk = await openDialog(page, "Bulk Add");
      await bulkValue(envBulk).fill("EMPTY_BULK_ENV=");
      await envBulk.getByText("0 protected secrets detected").waitFor();
      await bulkValue(envBulk).fill('BULK_PRIVATE_KEY="line one\nline two"\nEMPTY_BULK_ENV=');
      await envBulk.getByText("1 protected secret detected").waitFor();
      await button(envBulk, "Save").click();
      await notice(
        page,
        "Saved 2 entries (1 protected, 1 agent-readable). Protected secrets need a SecretRef or enabled destination-bound Gateway egress; agent-readable environment values reach Gateway-hosted agent commands from the next run.",
      );

      expect((await gateway.getRequests("secrets.store.set")).map(({ params }) => params)).toEqual([
        {
          name: "SERVICE_API_KEY",
          value: "super-secret-material",
          kind: "secret",
          allowedHosts: ["api.example.com"],
        },
        { name: "EMPTY_ENV", value: "", kind: "env" },
        { name: "BULK_PRIVATE_KEY", value: "line one\nline two", kind: "secret" },
        { name: "EMPTY_BULK_ENV", value: "", kind: "env" },
      ]);
    });
  });

  it.each([false, true])(
    "handles confirmed deletion after reconnect (replace client: %s)",
    async (replace) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await openStore(page, {
          list: { sequence: [[envEntry], [envEntry], []].map((entries) => ({ entries })) },
          delete: saved,
        });
        const deletions = () => gateway.getRequests("secrets.store.delete");
        const entryRow = await rowAction(page, "SERVICE_URL", "delete");
        const confirmation = modal(page, "Delete");
        await confirmation.getByText("Delete SERVICE_URL?", { exact: true }).waitFor();
        const original = await gatewayIdentity(page);
        expect(original.clientInstanceId).toBeDefined();
        const listCount = (await gateway.getRequests("secrets.store.list")).length;
        if (replace) {
          await evaluateControlUiContext(page, (context) => {
            context.gateway.connect({ token: "replacement-secret-delete-proof" });
          });
        } else {
          await gateway.closeLatest(1012, "secret delete confirmation reconnect proof");
        }
        await expect
          .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
          .toBeGreaterThan(listCount);
        await expect
          .poll(() => gatewayIdentity(page))
          .toMatchObject({
            gatewayUrl: original.gatewayUrl,
            phase: "connected",
            ...(replace ? {} : { clientInstanceId: original.clientInstanceId }),
          });
        if (replace) {
          expect((await gatewayIdentity(page)).clientInstanceId).not.toBe(
            original.clientInstanceId,
          );
          await expect.poll(() => button(entryRow, "Actions: SERVICE_URL").isEnabled()).toBe(true);
        }
        await button(confirmation, "Delete").click();
        if (replace) {
          await page
            .getByRole("alert")
            .getByText("The secret was not deleted. Reload the list and try again.", {
              exact: true,
            })
            .waitFor();
          expect(await deletions()).toHaveLength(0);
          await entryRow.waitFor();
        } else {
          await expect.poll(async () => (await deletions()).length).toBe(1);
          await expect.poll(() => entryRow.count()).toBe(0);
          await notice(page, "Deleted SERVICE_URL.");
        }
      });
    },
  );
});
