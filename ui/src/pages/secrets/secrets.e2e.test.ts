import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI team secrets mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDir = createControlUiE2eArtifactDir(
      "secrets-store",
      path.join(process.cwd(), ".artifacts", "control-ui-e2e", "secrets-store"),
    );
  }
});

const entryMetadata = {
  scopeKind: "team",
  scopeId: "",
  createdAtMs: 1_786_352_400_000,
  updatedAtMs: 1_786_352_400_000,
  updatedBy: "E2E Operator",
} satisfies Partial<SecretStoreEntry>;

const envEntry: SecretStoreEntry = {
  ...entryMetadata,
  name: "SERVICE_URL",
  kind: "env",
  value: "https://service.test",
};

const secretEntry: SecretStoreEntry = {
  ...entryMetadata,
  name: "SERVICE_API_KEY",
  kind: "secret",
  allowedHosts: ["api.example.com"],
};

const bulkEnvEntry: SecretStoreEntry = {
  ...envEntry,
  name: "BULK_URL",
  value: "https://bulk.test",
};

const bulkSecretEntry: SecretStoreEntry = {
  ...secretEntry,
  name: "BULK_PRIVATE_KEY",
  allowedHosts: [],
};

const longNameSecretEntry: SecretStoreEntry = {
  ...secretEntry,
  name: "REUTERS_OUTLOOK_CALENDAR_ICS_PRODUCTION_ACCESS_TOKEN",
};

async function capture(
  page: Page,
  fileName: string,
  surface: Locator = page.locator(".shell"),
  content: readonly Locator[] = [
    page.locator(".settings-section__heading", { hasText: "Secrets" }),
  ],
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  if (page.video()) {
    await writeFile(
      path.join(proofDir, fileName),
      await takeControlUiViewportScreenshot(page, surface, content),
    );
  } else {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(proofDir, fileName),
    });
  }
}

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

async function activeGatewayIdentity(page: Page) {
  return await evaluateControlUiContext(page, (context) => {
    const gateway = context.gateway;
    return {
      clientInstanceId: gateway.snapshot.client?.instanceId,
      gatewayUrl: gateway.connection.gatewayUrl,
      phase: gateway.snapshot.phase,
    };
  });
}

const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const field = (scope: Locator, name: string) => scope.getByLabel(name, { exact: true });
const bulkValue = (scope: Locator) => scope.getByRole("textbox", { name: "Value", exact: true });
const modal = (page: Page, label: string) =>
  page.locator(`openclaw-modal-dialog[label="${label}"]`);
const notice = (page: Page, text: string | RegExp) =>
  page.getByRole("status").getByText(text).waitFor();
const validation = (dialog: Locator, text: string) =>
  dialog.getByRole("alert").getByText(text).waitFor();
const openSecrets = (page: Page) => page.goto(`${suite.server.baseUrl}settings/secrets`);
const listResponse = (...snapshots: SecretStoreEntry[][]) => ({
  sequence: snapshots.map((entries) => ({ entries })),
});
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

async function expectMode(dialog: Locator, name: RegExp) {
  expect(await dialog.getByRole("radio", { name }).isChecked()).toBe(true);
}

async function captureDialog(page: Page, file: string, dialog: Locator, content: Locator) {
  await capture(page, file, dialog.locator("dialog"), [content]);
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

async function prepareDeletion(page: Page) {
  const gateway = await openStore(page, {
    list: listResponse([envEntry], [envEntry], []),
    delete: saved,
  });
  const entryRow = await rowAction(page, "SERVICE_URL", "delete");
  const confirmation = modal(page, "Delete");
  await confirmation.getByText("Delete SERVICE_URL?", { exact: true }).waitFor();
  return { gateway, entryRow, confirmation };
}

async function waitForReconnect(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  socketCount: number,
  listCount: number,
) {
  await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
  await expect
    .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
    .toBeGreaterThan(listCount);
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

  it("keeps long secret names inside the Name column", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
      await openStore(page, { list: { entries: [longNameSecretEntry] } });
      const row = page.getByRole("row", { name: longNameSecretEntry.name });
      const name = row.locator(".secrets-store__name");
      const access = row.locator(".secrets-store__mode");

      expect(await name.getAttribute("title")).toBe(longNameSecretEntry.name);
      const [nameBox, accessBox] = await Promise.all([name.boundingBox(), access.boundingBox()]);
      if (!nameBox || !accessBox) {
        throw new Error("Expected Name and Access cells to have layout boxes");
      }
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(accessBox.x);
      const nameStyle = await name.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          overflowX: style.overflowX,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          overflows: element.scrollWidth > element.clientWidth,
        };
      });
      expect(nameStyle).toEqual({
        overflowX: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        overflows: true,
      });
    });
  });

  it("wraps long secret names in the stacked phone layout", async () => {
    await suite.withPage({ viewport: { height: 844, width: 390 } }, async ({ page }) => {
      await openStore(page, { list: { entries: [longNameSecretEntry] } });
      const row = page.getByRole("row", { name: longNameSecretEntry.name });
      const name = row.locator(".secrets-store__name");

      expect(await name.textContent()).toBe(longNameSecretEntry.name);
      const nameStyle = await name.evaluate((element) => {
        const style = getComputedStyle(element);
        const text = document.createRange();
        text.selectNodeContents(element);
        return {
          overflowWrap: style.overflowWrap,
          whiteSpace: style.whiteSpace,
          fitsHorizontally: element.scrollWidth <= element.clientWidth,
          wraps: text.getClientRects().length > 1,
        };
      });
      expect(nameStyle).toEqual({
        overflowWrap: "anywhere",
        whiteSpace: "normal",
        fitsHorizontally: true,
        wraps: true,
      });
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
    });
  });

  it("blocks empty protected values without rejecting empty environment entries", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await openStore(page, {
        list: listResponse([secretEntry], [secretEntry], [secretEntry]),
        set: { sequence: [saved, saved] },
      });
      await page.getByRole("heading", { name: "Secrets", level: 1, exact: true }).waitFor();

      await rowAction(page, "SERVICE_API_KEY", "edit");
      const editSecret = modal(page, "Edit");
      await button(editSecret, "Save").click();
      await validation(editSecret, "Enter a value.");
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      await button(editSecret, "Cancel").click();

      const addSecret = await openDialog(page, "Add");
      await field(addSecret, "Name").fill("EMPTY_API_KEY");
      await expectMode(addSecret, /Protected secret/u);
      await button(addSecret, "Save").click();
      await validation(addSecret, "Enter a value.");
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      await capture(page, "04-empty-secret-local-validation.png");
      await button(addSecret, "Cancel").click();

      const protectedBulk = await openDialog(page, "Bulk Add");
      await bulkValue(protectedBulk).fill("EMPTY_API_KEY=\nEMPTY_ENV=");
      await protectedBulk.getByText("1 protected secret detected").waitFor();
      await button(protectedBulk, "Save").click();
      await validation(protectedBulk, "EMPTY_API_KEY: Enter a value.");
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      await capture(page, "05-empty-bulk-local-validation.png");
      await button(protectedBulk, "Cancel").click();

      const addEnv = await openDialog(page, "Add");
      await field(addEnv, "Name").fill("EMPTY_ENV");
      await expectMode(addEnv, /Agent-readable environment/u);
      await button(addEnv, "Save").click();
      await notice(page, /Saved EMPTY_ENV/u);

      const envBulk = await openDialog(page, "Bulk Add");
      await bulkValue(envBulk).fill("EMPTY_BULK_ENV=");
      await envBulk.getByText("0 protected secrets detected").waitFor();
      await button(envBulk, "Save").click();
      await notice(page, /Saved 1 entries/u);

      expect(await gateway.getRequests("secrets.store.set")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ name: "EMPTY_ENV", value: "", kind: "env" }),
        }),
        expect.objectContaining({
          params: { name: "EMPTY_BULK_ENV", value: "", kind: "env" },
        }),
      ]);
    });
  });

  it("adds env and secret values, bulk imports, and deletes without revealing secrets", async () => {
    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await openStore(page, {
          list: listResponse(
            [],
            [envEntry],
            [envEntry, secretEntry],
            [envEntry, secretEntry, bulkSecretEntry],
            [envEntry, secretEntry, bulkSecretEntry, bulkEnvEntry],
            [envEntry, secretEntry, bulkSecretEntry],
          ),
          set: { sequence: [saved, { ok: true, reloaded: true, warningCount: 2 }, saved, saved] },
          delete: saved,
        });
        await page.getByRole("heading", { name: "Secrets", level: 1, exact: true }).waitFor();

        const addDialog = await openDialog(page, "Add");
        await addDialog.getByText("Agent-readable environment", { exact: true }).waitFor();
        await expectMode(addDialog, /Agent-readable environment/u);
        await addDialog.getByText(/The agent can print, transmit, or persist it/u).waitFor();
        await field(addDialog, "Name").fill("SERVICE_URL");
        await field(addDialog, "Value").fill("https://service.test");
        await captureDialog(page, "02-add-dialog.png", addDialog, field(addDialog, "Value"));
        await button(addDialog, "Save").click();
        await notice(
          page,
          "Saved SERVICE_URL as Agent-readable environment. It is available to Gateway-hosted agent commands from the next run.",
        );

        const secretDialog = await openDialog(page, "Add");
        await field(secretDialog, "Name").fill("SERVICE_API_KEY");
        await expectMode(secretDialog, /Protected secret/u);
        await field(secretDialog, "Value").fill("super-secret-material");
        await secretDialog.locator('textarea[name="allowed-hosts"]').fill("api.example.com");
        await captureDialog(
          page,
          "02-secret-allowed-hosts.png",
          secretDialog,
          secretDialog.locator('textarea[name="allowed-hosts"]'),
        );
        await field(secretDialog, "Name").press("Enter");
        await notice(
          page,
          "Saved SERVICE_API_KEY as Protected secret. Add a SecretRef or enable destination-bound Gateway egress to use it. 2 runtime warnings.",
        );
        expect(await page.content()).not.toContain("super-secret-material");
        await page.getByRole("columnheader", { name: "Access" }).waitFor();
        expect(await page.getByRole("row", { name: /SERVICE_URL/u }).textContent()).toContain(
          "Agent-readable environment",
        );
        const secretRow = await page.getByRole("row", { name: /SERVICE_API_KEY/u }).textContent();
        expect(secretRow).toContain("Protected secret");
        expect(secretRow).toContain("api.example.com");

        const bulkDialog = await openDialog(page, "Bulk Add");
        await bulkValue(bulkDialog).fill(
          'BULK_PRIVATE_KEY="line one\nline two"\nBULK_URL=https://bulk.test',
        );
        await bulkDialog.getByText("1 protected secret detected").waitFor();
        await captureDialog(page, "03-bulk-add-dialog.png", bulkDialog, bulkValue(bulkDialog));
        await button(bulkDialog, "Save").click();
        await notice(
          page,
          "Saved 2 entries (1 protected, 1 agent-readable). Protected secrets need a SecretRef or enabled destination-bound Gateway egress; agent-readable environment values reach Gateway-hosted agent commands from the next run.",
        );

        await rowAction(page, "BULK_URL", "delete");
        const confirm = modal(page, "Delete");
        await button(confirm, "Delete").click();
        await notice(page, "Deleted BULK_URL.");
        expect(await page.getByRole("row", { name: /BULK_URL/u }).count()).toBe(0);

        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(4);
        expect((await gateway.getRequests("secrets.store.set"))[1]?.params).toMatchObject({
          name: "SERVICE_API_KEY",
          allowedHosts: ["api.example.com"],
        });
        expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(1);
        expect(await page.content()).not.toContain("super-secret-material");
        expect(await tableBodyContrast(page)).toBeGreaterThanOrEqual(9.5);
        await capture(page, "01-populated-dark.png");
      },
    );
  });

  it("rejects a confirmed deletion after same-URL credentials replace the Gateway client", async () => {
    await suite.withPage({}, async ({ page }) => {
      const { gateway, entryRow, confirmation } = await prepareDeletion(page);

      const socketCount = await gateway.getSocketCount();
      const listCount = (await gateway.getRequests("secrets.store.list")).length;
      const originalGateway = await evaluateControlUiContext(page, (context) => {
        const activeGateway = context.gateway;
        const client = activeGateway.snapshot.client;
        if (!client) {
          throw new Error("Expected a connected Gateway client before confirmation");
        }
        const identity = {
          clientInstanceId: client.instanceId,
          gatewayUrl: activeGateway.connection.gatewayUrl,
        };
        activeGateway.connect({ token: "replacement-secret-delete-proof" });
        return identity;
      });
      await waitForReconnect(gateway, socketCount, listCount);
      await expect
        .poll(() => activeGatewayIdentity(page))
        .toMatchObject({
          gatewayUrl: originalGateway.gatewayUrl,
          phase: "connected",
        });
      const replacementGateway = await activeGatewayIdentity(page);
      expect(replacementGateway.clientInstanceId).not.toBe(originalGateway.clientInstanceId);
      await expect
        .poll(() => entryRow.getByRole("button", { name: "Actions: SERVICE_URL" }).isEnabled())
        .toBe(true);

      await button(confirmation, "Delete").click();

      await expect
        .poll(async () => ({
          alerts: await page.getByRole("alert").count(),
          deletes: (await gateway.getRequests("secrets.store.delete")).length,
        }))
        .not.toEqual({ alerts: 0, deletes: 0 });
      expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(0);
      await page
        .getByRole("alert")
        .getByText("The secret was not deleted. Reload the list and try again.", { exact: true })
        .waitFor();
      await capture(page, "06-client-replacement-delete-rejected.png");
      await entryRow.waitFor();
    });
  });

  it("deletes a confirmed entry after the same Gateway client reconnects", async () => {
    await suite.withPage({}, async ({ page }) => {
      const { gateway, entryRow, confirmation } = await prepareDeletion(page);

      const originalGateway = await activeGatewayIdentity(page);
      const socketCount = await gateway.getSocketCount();
      const listCount = (await gateway.getRequests("secrets.store.list")).length;
      await gateway.closeLatest(1012, "secret delete confirmation reconnect proof");
      await waitForReconnect(gateway, socketCount, listCount);
      await expect
        .poll(() => activeGatewayIdentity(page))
        .toMatchObject({
          clientInstanceId: originalGateway.clientInstanceId,
          gatewayUrl: originalGateway.gatewayUrl,
          phase: "connected",
        });

      await button(confirmation, "Delete").click();

      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.delete")).length)
        .toBe(1);
      await expect.poll(() => entryRow.count()).toBe(0);
    });
  });

  it("keeps optional store actions hidden when the Gateway omits method discovery", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        omitFeatureMethods: true,
        methodResponses: {
          "secrets.store.list": { entries: [] },
        },
      });

      await openSecrets(page);
      await page.getByRole("heading", { name: "Secrets", level: 1, exact: true }).waitFor();
      await page.getByText(/Gateway\/admin required/u).waitFor();
      expect(await button(page, "Add").count()).toBe(0);
      expect(await button(page, "Bulk Add").count()).toBe(0);
      expect(await gateway.getRequests("secrets.store.list")).toHaveLength(0);
    });
  });
});
