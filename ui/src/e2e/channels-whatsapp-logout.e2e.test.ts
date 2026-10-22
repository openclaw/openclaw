import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildChannelWizardMocks } from "../../../scripts/control-ui-mock-channels.ts";
import {
  installMockGateway,
  type MockGatewayControls,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { configSchema, configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI WhatsApp logout mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=";
const pairing = {
  accounts: [],
  requests: [],
  commandOwnerConfigured: true,
  limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
};
const linked = { configured: true, linked: true, running: true, connected: true };
function channelStatus(
  labels: Record<string, string>,
  channels: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    ts: Date.now(),
    channelOrder: Object.keys(labels),
    channelLabels: labels,
    channels,
    channelAccounts: {},
    channelDefaultAccountId: {},
    ...overrides,
  };
}
const whatsappStatus = (overrides: Record<string, unknown> = {}) =>
  channelStatus(
    { whatsapp: "WhatsApp" },
    { whatsapp: { ...linked, reconnectAttempts: 0 } },
    overrides,
  );
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const contextOptions = { locale: "en-US", serviceWorkers: "block" } as const;
function withChannels(
  responses: Record<string, unknown>,
  run: (
    page: Page,
    gateway: MockGatewayControls,
    assets: Array<{ url: string; status: number }>,
  ) => Promise<void>,
  options: NonNullable<Parameters<typeof suite.withPage>[0]> = contextOptions,
  featureMethods?: string[],
) {
  return suite.withPage(options, async ({ page }) => {
    const assets: Array<{ url: string; status: number }> = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.url().includes("/assets/plugins/whatsapp/")) {
        assets.push({ url: new URL(response.url()).pathname, status: response.status() });
      }
    });
    const gateway = await installMockGateway(page, {
      featureMethods,
      methodResponses: {
        "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
        "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
        "channels.status": whatsappStatus(),
        "channels.pairing.list": pairing,
        ...responses,
      },
    });
    expect((await page.goto(`${suite.server.baseUrl}settings/channels`))?.status()).toBe(200);
    await run(page, gateway, assets);
    if (assets.length) {
      expect(assets.some((asset) => asset.url.endsWith(".js") && asset.status === 200)).toBe(true);
      expect(assets.every((asset) => asset.status === 200)).toBe(true);
      expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
    }
    expect(errors).toEqual([]);
  });
}
async function openChannel(page: Page, name = "WhatsApp") {
  await page
    .locator("button.channels-item, button.channels-item__detail", { hasText: name })
    .first()
    .click();
  const detail = page.locator(".channels-detail");
  await detail.waitFor();
  return detail;
}
const requestCount = async (gateway: MockGatewayControls, method: string) =>
  (await gateway.getRequests(method)).length;
const expectRequests = (gateway: MockGatewayControls, method: string, count: number) =>
  expect.poll(() => requestCount(gateway, method)).toBe(count);
const field = (detail: Locator, name: string) =>
  detail.locator("dt", { hasText: name }).locator("xpath=following-sibling::dd[1]");
const button = (surface: Page | Locator, name: string) =>
  surface.getByRole("button", { name, exact: true });

suite.define(() => {
  it("completes direct setup as the selected channel", async () => {
    const channelWizard = buildChannelWizardMocks();
    await withChannels(
      {
        "channels.status": channelStatus(
          { slack: "Slack" },
          { slack: { configured: false, running: false } },
          { channelMeta: [{ id: "slack", label: "Slack" }] },
        ),
        "wizard.start": channelWizard.start,
        "wizard.next": channelWizard.next,
      },
      async (page, gateway) => {
        const slackRow = page.locator(".channels-item", { hasText: "Slack" }).first();
        await slackRow.getByRole("button", { name: "Set up", exact: true }).click();
        const wizard = page.locator(".channels-wizard");
        await button(wizard, "Continue").click();

        expect((await gateway.getRequests("wizard.next")).map(({ params }) => params)).toEqual([
          {
            sessionId: "mock-wizard-session",
            answer: { stepId: "mock-wizard-step-slack", value: null },
          },
        ]);
        await wizard.getByText("Channel configured", { exact: true }).waitFor();
        await wizard.getByRole("heading", { name: "Set up Slack" }).waitFor();
      },
      contextOptions,
      ["channels.status", "channels.pairing.list", "wizard.start", "wizard.next"],
    );
  });

  it("shows rejected channel configuration saves in the open editor without losing the draft", async () => {
    const config = { channels: { whatsapp: { enabled: true } } };
    await withChannels(
      {
        "config.get": configSnapshot(config, "channel-config-1"),
        "config.schema": configSchema(
          objectSchema({
            channels: objectSchema({
              whatsapp: objectSchema({ enabled: { type: "boolean", title: "Enabled" } }),
            }),
          }),
          { "channels.whatsapp.enabled": { advanced: false } },
        ),
      },
      async (page, gateway) => {
        const detail = await openChannel(page);
        const enabled = detail.getByRole("switch", { name: "Enabled" });
        await enabled.waitFor();

        await gateway.deferNext("config.set");
        await enabled.click();
        await gateway.waitForRequest("config.set");
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "automatic channel save rejected",
        });
        const alert = detail.getByRole("alert");
        await expect.poll(() => alert.textContent()).toContain("automatic channel save rejected");

        const save = button(detail, "Save");
        await expect.poll(() => save.isEnabled()).toBe(true);
        const writesBefore = await requestCount(gateway, "config.set");
        const readsBefore = await requestCount(gateway, "config.get");
        await gateway.deferNext("config.set");
        await save.click();
        const request = await gateway.waitForRequest("config.set", { after: writesBefore });
        expect(request.params).toMatchObject({ baseHash: "channel-config-1" });
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message:
            "channel rejected: OPENAI_API_KEY=sk-1234567890abcdef <img src=x onerror=alert(1)>",
        });

        await expect.poll(() => alert.textContent()).toContain("channel rejected");
        const message = await alert.textContent();
        expect(message).toContain("OPENAI_API_KEY=sk-123...cdef");
        expect(message).not.toContain("sk-1234567890abcdef");
        expect(await alert.locator("img").count()).toBe(0);
        expect(await save.isEnabled()).toBe(true);
        expect(await enabled.isChecked()).toBe(false);
        expect(await gateway.getRequests("config.get")).toHaveLength(readsBefore);
      },
      {
        ...contextOptions,
        viewport: { height: 900, width: 1280 },
      },
    );
  });

  it("shows rejected WhatsApp login immediately without waiting for channel status", async () => {
    await withChannels(
      {
        "channels.status": whatsappStatus({ channels: { whatsapp: linked } }),
      },
      async (page, gateway) => {
        const detail = await openChannel(page);
        const relink = detail.getByRole("button", { name: "Relink" });
        await relink.waitFor();
        const statusReadsBefore = (await gateway.getRequests("channels.status")).length;
        await gateway.deferNext("channels.status", { probe: true });
        await gateway.deferNext("web.login.start");

        await relink.click();
        await gateway.waitForRequest("web.login.start");
        await gateway.rejectDeferred("web.login.start", {
          code: "INVALID_REQUEST",
          message: "WhatsApp login rejected",
        });

        await expect.poll(() => detail.textContent()).toContain("WhatsApp login rejected");
        await expect.poll(() => relink.isEnabled()).toBe(true);
        expect(await gateway.getRequests("channels.status")).toHaveLength(statusReadsBefore);
      },
      { ...contextOptions, viewport: { height: 900, width: 1280 } },
    );
  });

  it("confirms the explicit default account and preserves a no-op logout", async () => {
    await withChannels(
      {
        "web.login.start": {
          connected: false,
          message: "Scan this QR.",
          qrDataUrl: QR_DATA_URL,
        },
        "channels.logout": {
          channel: "whatsapp",
          accountId: "default",
          cleared: false,
          loggedOut: false,
        },
      },
      async (page, gateway, assets) => {
        const detail = await openChannel(page);
        const logout = detail.getByRole("button", { name: "Logout" });
        await logout.waitFor();
        expect(assets.some((asset) => asset.url.endsWith(".js") && asset.status === 200)).toBe(
          true,
        );

        await detail.getByRole("button", { name: "Relink" }).click();
        const qr = detail.getByRole("img", { name: "WhatsApp QR" });
        await qr.waitFor();
        await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);

        await logout.click();
        await expectRequests(gateway, "channels.logout", 0);
        const firstConfirm = await waitForConfirmModal(page);
        const confirmation = await firstConfirm.textContent();
        expect(confirmation).toContain("Log out of WhatsApp account default?");
        expect(confirmation).toContain(
          "Logging out of account default stops its listener and deletes its saved credentials.",
        );
        await button(firstConfirm, "Cancel").focus();
        await page.keyboard.press("Escape");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(1);
        await expectRequests(gateway, "channels.logout", 0);
        await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);
        await expect.poll(() => field(detail, "Linked").textContent()).toContain("Yes");

        await logout.click();
        const secondConfirm = await waitForConfirmModal(page);
        await button(secondConfirm, "Logout").click();
        await expect
          .poll(async () => detail.locator(".settings-row__desc").allTextContents())
          .toContain(
            "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
          );
        await expect(qr.getAttribute("src")).resolves.toBe(QR_DATA_URL);
        await expect(detail.getByText("Logged out.", { exact: true }).count()).resolves.toBe(0);
        await expectRequests(gateway, "channels.logout", 1);
        expect((await gateway.getRequests("channels.logout"))[0]?.params).toEqual({
          channel: "whatsapp",
          accountId: "default",
        });
        await expectRequests(gateway, "channels.status", 3);
      },
      { ...contextOptions, viewport: { height: 1000, width: 1280 } },
    );
  });

  it("renders the packaged phone identity with raw fallback and no JID fallback", async () => {
    await withChannels({}, async (page, gateway) => {
      const detail = await openChannel(page);
      await detail.getByRole("button", { name: "Relink" }).waitFor();
      const phone = field(detail, "Phone number");
      for (const [self, expected] of [
        [{ e164: "+4930123456", jid: "4930123456@s.whatsapp.net" }, "Germany · +49 30 123456"],
        [{ e164: "not-a-phone", jid: "account@s.whatsapp.net" }, "not-a-phone"],
        [{ jid: "account@s.whatsapp.net" }, null],
      ] as const) {
        await gateway.setMethodResponse(
          "channels.status",
          channelStatus(
            { whatsapp: "WhatsApp" },
            { whatsapp: { ...linked, self, authAgeMs: 60000 } },
          ),
        );
        const before = await gateway.getRequests("channels.status", { probe: true });
        await button(detail, "Refresh").click();
        await gateway.waitForRequest("channels.status", {
          after: before.length,
          match: { probe: true },
        });
        if (expected === null) {
          await expect.poll(() => phone.count()).toBe(0);
        } else {
          await expect.poll(() => phone.textContent()).toBe(expected);
        }
        await expect.poll(() => field(detail, "Auth age").textContent()).toBe("1m");
      }
    });
  });

  it("rejects a captured custom-account logout after the Gateway reconnects", async () => {
    await withChannels(
      {
        "channels.status": whatsappStatus({
          channelAccounts: {
            whatsapp: [{ accountId: "work", ...linked }],
          },
          channelDefaultAccountId: { whatsapp: "work" },
        }),
        "channels.logout": {
          channel: "whatsapp",
          accountId: "work",
          cleared: true,
          loggedOut: true,
        },
      },
      async (page, gateway) => {
        const detail = await openChannel(page);
        await detail.getByRole("button", { name: "Logout" }).click();
        const confirm = (await waitForConfirmModal(page)).filter({
          has: page.getByText("Log out of WhatsApp account work?", { exact: true }),
        });
        await expect.poll(() => confirm.count()).toBe(1);
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1012, "Reconnect during logout confirmation");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await expect.poll(() => confirm.count()).toBe(0);
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(1);
        await expectRequests(gateway, "channels.logout", 0);
      },
    );
  });

  it("preserves standard channel details and the complete Telegram setup wizard", async () => {
    const channelEntries = [
      ["discord", "Discord"],
      ["googlechat", "Google Chat"],
      ["imessage", "iMessage"],
      ["signal", "Signal"],
      ["slack", "Slack"],
      ["telegram", "Telegram"],
    ] as const;
    const running = { configured: true, running: true };
    const details: Record<string, Record<string, unknown>> = {
      googlechat: {
        credentialSource: "service-account",
        audienceType: "url",
        audience: "https://chat.example.test",
      },
      signal: { baseUrl: "https://signal.example.test" },
    };
    const bot = (accountId: string, username: string) => ({
      accountId,
      ...running,
      probe: { bot: { username } },
    });
    const step = (id: string, type: string, values: Record<string, unknown> = {}) => ({
      done: false,
      status: "running",
      step: { id, type, ...values },
    });
    await withChannels(
      {
        "channels.status": channelStatus(
          Object.fromEntries(channelEntries),
          Object.fromEntries(channelEntries.map(([id]) => [id, { ...running, ...details[id] }])),
          {
            channelMeta: channelEntries.map(([id, label]) => ({ id, label })),
            channelAccounts: {
              telegram: [bot("personal", "alpha_bot"), bot("work", "work_bot")],
            },
            channelDefaultAccountId: { telegram: "personal" },
          },
        ),
        "wizard.start": {
          sessionId: "channel-standard-proof",
          ...step("account", "select", {
            message: "Choose Telegram account",
            initialValue: "personal",
            options: [
              { value: "personal", label: "Personal bot" },
              { value: "work", label: "Work bot" },
            ],
          }),
        },
        "wizard.next": {
          sequence: [
            step("token", "text", { message: "Telegram bot token", sensitive: true }),
            step("features", "multiselect", {
              initialValue: ["alpha"],
              options: [
                { value: "alpha", label: "Alpha" },
                { value: "beta", label: "Beta" },
              ],
            }),
            step("confirm", "confirm", { message: "Apply Telegram settings?" }),
            step("progress", "progress", { executor: "gateway", message: "Finish preparation" }),
            { done: true, status: "done", channels: ["telegram"], accounts: [] },
          ],
        },
      },
      async (page, gateway) => {
        const expectedFields: Record<string, string[]> = {
          googlechat: ["service-account", "url · https://chat.example.test"],
          signal: ["https://signal.example.test"],
          telegram: ["@alpha_bot", "@work_bot", "2"],
        };
        for (const [channelId, label] of channelEntries) {
          const detail = await openChannel(page, label);
          await expect
            .poll(() => detail.locator("h2.settings-section__heading").textContent())
            .toContain(label);
          await detail.getByRole("button", { name: "Check connection" }).waitFor();
          for (const value of expectedFields[channelId] ?? []) {
            await detail.getByText(value, { exact: true }).waitFor();
          }
          if (channelId !== "telegram") {
            await detail.getByRole("button", { name: "Close" }).click();
          }
        }

        await page.locator(".channels-detail").getByRole("button", { name: "Run setup" }).click();
        const wizard = page.locator(".channels-wizard");
        await gateway.deferNext("wizard.next");
        const account = wizard.locator("openclaw-select-picker");
        await selectPickerValue(account, "1");
        await expectRequests(gateway, "wizard.next", 1);
        await expect
          .poll(() => account.locator(".picker-select__trigger").getAttribute("disabled"))
          .not.toBeNull();
        const busyButton = wizard.locator('button[aria-busy="true"]');
        await expect.poll(() => busyButton.getAttribute("disabled")).not.toBeNull();
        await expect.poll(() => busyButton.locator(".btn__label").textContent()).toBe("Continue");
        await expect.poll(() => busyButton.locator(".btn__spinner").count()).toBe(1);
        await expect
          .poll(() => wizard.locator(".channels-wizard__spinner", { hasText: "Working…" }).count())
          .toBe(0);
        await gateway.resolveDeferred("wizard.next");

        const token = wizard.getByLabel("Telegram bot token");
        await expect.poll(() => token.getAttribute("type")).toBe("password");
        await token.fill("123456:proof-secret");
        await button(wizard, "Continue").click();
        const beta = wizard.getByRole("button", { name: /Beta/u });
        await expect.poll(() => beta.getAttribute("aria-pressed")).toBe("false");
        await beta.click();
        await expect.poll(() => beta.getAttribute("aria-pressed")).toBe("true");
        await button(wizard, "Continue").click();
        await button(wizard, "Yes").click();
        await button(wizard, "Finish").waitFor();

        const userAnswers = [
          ["account", "work"],
          ["token", "123456:proof-secret"],
          ["features", ["alpha", "beta"]],
          ["confirm", true],
        ] as const;
        expect((await gateway.getRequests("wizard.next")).map(({ params }) => params)).toEqual([
          ...userAnswers.map(([stepId, value]) => ({
            sessionId: "channel-standard-proof",
            answer: { stepId, value },
          })),
          { sessionId: "channel-standard-proof" },
        ]);
      },
      contextOptions,
      ["channels.status", "channels.pairing.list", "wizard.start", "wizard.next"],
    );
  });
});
