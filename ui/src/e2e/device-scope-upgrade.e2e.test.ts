import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI live device scope upgrade",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});
const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let proofDir: string | undefined;
beforeEach(() => {
  proofDir = artifactRoot
    ? createControlUiE2eArtifactDir("device-scope-upgrade", artifactRoot)
    : undefined;
});

const LIMITED_SCOPES = ["operator.read", "operator.write"];
const FULL_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];
const SCOPE_UPGRADE_METHODS = [
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
] as const;
const MANUAL_UPGRADE_GUIDANCE = "Ask an admin to approve this browser in Devices.";

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

async function captureProof(page: Page, name: string, surface: Locator): Promise<void> {
  if (!proofDir) {
    return;
  }
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, surface, [surface]),
  );
}

async function createContext(viewport = { height: 900, width: 1280 }): Promise<BrowserContext> {
  return await suite.newBrowserContext({
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
}

async function openInbox(page: Page, mobile = false) {
  if (mobile) {
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.locator(".nav-drawer").waitFor();
  }
  const trigger = page.locator(".sidebar-issues-button:visible");
  await trigger.waitFor();
  await trigger.click();
  const panel = page.locator("#sidebar-issues-panel");
  await panel.waitFor();
  return panel;
}

async function waitForPendingUpgradeItem(item: Locator) {
  await item
    .getByText(
      /Ask an admin to approve this browser in Devices or run openclaw devices approve upgrade-1 on the Gateway/u,
    )
    .waitFor();
  await item.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await item.getByRole("button", { name: "Cancel", exact: true }).waitFor();
}

suite.define(() => {
  it("does not turn limited browser access into an Inbox item", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });
    await page.goto(`${suite.server.baseUrl}new`);
    const panel = await openInbox(page);
    await panel.getByRole("tab", { name: /System/u }).waitFor();
    await captureProof(page, "limited-browser-inbox.png", panel);
    await panel.getByText("No requests or alerts yet.", { exact: true }).waitFor();
    expect(await panel.getByText("Limited access", { exact: true }).count()).toBe(0);
    expect(await page.locator(".sidebar-issues-button:visible").getAttribute("aria-label")).toBe(
      "0 inbox items",
    );
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });
  it.each([false, true])(
    "keeps the Inbox quiet and respects the role ceiling in Profile: %s",
    async (roleAllowsAdmin) => {
      const page = await (await createContext({ width: 390, height: 844 })).newPage();
      const gateway = await installMockGateway(page, {
        roleAllowsAdmin,
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
        operatorSessionCap: roleAllowsAdmin ? "none" : "view",
      });
      await page.goto(new URL("new", suite.server.baseUrl).href);
      const panel = await openInbox(page, true);
      await panel.getByRole("tab", { name: "System", exact: true }).click();
      await panel.getByText("No requests or alerts yet.", { exact: true }).waitFor();
      await page.goto(new URL("settings/profile", suite.server.baseUrl).href);
      const access = page.locator("#settings-profile-access");
      const request = access.getByRole("button", { name: "Request admin", exact: true });
      if (roleAllowsAdmin) {
        await request.waitFor();
      } else {
        await access.getByText("Only admins can manage access. Ask an admin for access.").waitFor();
        expect(await request.count()).toBe(0);
      }
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    },
  );

  it("requests access explicitly from Profile and reconnects after approval", async () => {
    const page = await (await createContext()).newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.scopes.waitUpgrade"],
      operatorScopes: LIMITED_SCOPES,
      methodResponses: { "device.scopes.requestUpgrade": { requestId: "upgrade-1" } },
    });
    await page.goto(new URL("settings/profile", suite.server.baseUrl).href);
    const item = page.locator("#settings-profile-access");
    await item.getByRole("button", { name: "Request admin" }).click();
    const request = await gateway.waitForRequest("device.scopes.requestUpgrade");
    expect(request.params).toEqual({ scopes: FULL_SCOPES });
    const wait = await gateway.waitForRequest("device.scopes.waitUpgrade");
    expect(wait.params).toEqual({ requestId: "upgrade-1" });
    await waitForPendingUpgradeItem(item);
    await gateway.setOperatorScopes(FULL_SCOPES);
    await gateway.resolveDeferred("device.scopes.waitUpgrade", {
      status: "approved",
      requestId: "upgrade-1",
      deviceToken: "rotated-device-token",
      scopes: FULL_SCOPES,
    });
    await expect.poll(() => gateway.getSocketCount()).toBe(2);
    await expect.poll(async () => (await gateway.getRequests("connect")).length).toBe(2);
    const connects = await gateway.getRequests("connect");
    const reconnectParams = requireRecord(connects.at(-1)?.params);
    expect(reconnectParams.scopes).toEqual(FULL_SCOPES.toSorted());
    expect(requireRecord(reconnectParams.auth)).toEqual({
      deviceToken: "rotated-device-token",
    });
    await expect.poll(() => item.getByRole("button", { name: "Request admin" }).count()).toBe(0);
  });

  it("shows an administrator access request error once", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      operatorScopes: LIMITED_SCOPES,
      methodResponses: {
        "device.scopes.requestUpgrade": {
          __mockError: { code: "INVALID_REQUEST", message: "missing scope: operator.read" },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}settings/profile`);

    const item = page.locator("#settings-profile-access");
    await item.getByRole("button", { name: "Request admin" }).click();
    const message =
      "Couldn’t request admin access. Try again. Couldn’t complete this request. Ask an admin to grant read access.";
    await item.getByText(message, { exact: true }).waitFor();

    expect(await item.getByText(message, { exact: true }).count()).toBe(1);
    await captureProof(page, "desktop-profile-upgrade-error.png", item);
  });

  it.each(SCOPE_UPGRADE_METHODS)(
    "keeps role denials non-retryable at %s while transient errors can retry",
    async (method) => {
      const context = await createContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        deferredMethods: [method],
        operatorScopes: LIMITED_SCOPES,
        methodResponses: {
          "device.scopes.requestUpgrade": { requestId: "upgrade-1" },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      const item = page.locator("#settings-profile-access");
      await item.getByRole("button", { name: "Request admin" }).click();
      await gateway.waitForRequest(method);
      const denial =
        "Requested scopes exceed your assigned operator role; ask a gateway administrator to change your role.";
      // Role denials omit retryable on the wire; the request-error contract defaults it to false.
      await gateway.rejectDeferred(method, { code: "INVALID_REQUEST", message: denial });
      await item

        .getByText(denial, { exact: false })
        .waitFor();
      await captureProof(page, `${method}-role-denied.png`, item);
      expect(await item.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(1);

      await item.getByRole("button", { name: "Cancel", exact: true }).click();
      await gateway.deferNext(method);
      await item.getByRole("button", { name: "Request admin" }).click();
      await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(2);
      await gateway.rejectDeferred(method, {
        code: "UNAVAILABLE",
        message: "Device scope upgrade is temporarily unavailable.",
        retryable: true,
      });
      await item.getByRole("button", { name: "Retry", exact: true }).waitFor();
      await gateway.deferNext("device.scopes.waitUpgrade");
      await item.getByRole("button", { name: "Retry", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("device.scopes.requestUpgrade")).length)
        .toBe(3);
      await waitForPendingUpgradeItem(item);
      await captureProof(page, `${method}-retry-pending.png`, item);
      for (const status of ["rejected", "expired"] as const) {
        const requestCount = (await gateway.getRequests("device.scopes.requestUpgrade")).length;
        await gateway.resolveDeferred("device.scopes.waitUpgrade", {
          status,
          requestId: "upgrade-1",
        });
        await item.getByText(new RegExp(status)).waitFor();
        await gateway.deferNext("device.scopes.waitUpgrade");
        await item.getByRole("button", { name: "Retry", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("device.scopes.requestUpgrade")).length)
          .toBe(requestCount + 1);
        await waitForPendingUpgradeItem(item);
      }
    },
  );

  it.each(SCOPE_UPGRADE_METHODS)(
    "shows manual repair guidance in Profile when %s is not advertised",
    async (missingMethod) => {
      const context = await createContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          ...SCOPE_UPGRADE_METHODS.filter((method) => method !== missingMethod),
        ],
        operatorScopes: LIMITED_SCOPES,
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);

      const item = page.locator("#settings-profile-access");
      await item

        .getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true })
        .waitFor();
      expect(await item.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    },
  );

  it("offers the admin upgrade without crypto.subtle", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: undefined,
      });
    });
    const gateway = await installMockGateway(page, {
      operatorScopes: LIMITED_SCOPES,
      methodResponses: {
        "device.scopes.requestUpgrade": { requestId: "upgrade-insecure" },
      },
    });
    await page.goto(`${suite.server.baseUrl}settings/profile`);

    // Pure-JS Ed25519 keeps signed scope-upgrade requests available when
    // WebCrypto lacks subtle crypto (for example, an insecure LAN origin).
    const item = page.locator("#settings-profile-access");
    await item.getByRole("button", { name: "Request admin" }).waitFor();
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("shows manual repair guidance when the browser cannot mint a device identity", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: undefined,
      });
    });
    const gateway = await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });
    await page.goto(`${suite.server.baseUrl}settings/profile`);

    // Without a secure RNG the client cannot mint the device identity that
    // binds an upgrade request, so Profile must show manual repair guidance.
    const item = page.locator("#settings-profile-access");
    await item

      .getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true })
      .waitFor();
    expect(await item.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("never adds a limited-access Inbox item for admin connections", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { operatorScopes: FULL_SCOPES });
    await page.goto(`${suite.server.baseUrl}new`);
    const panel = await openInbox(page);
    await panel.getByText("No requests or alerts yet.", { exact: true }).waitFor();

    expect(await page.locator(".sidebar-issues-button__count").count()).toBe(0);
    expect(await page.locator('[data-attention-kind="scopeUpgrade"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });
});
