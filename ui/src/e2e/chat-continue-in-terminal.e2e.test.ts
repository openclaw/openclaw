import type { Page, Locator } from "playwright";
import { expect, it } from "vitest";
import { decodeResumeHandoff } from "../../../src/shared/resume-handoff.js";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails } from "./chat-details.test-support.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { exactButton, polledAttribute, polledClipboard } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI continue in terminal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const basePath = new URL("/nested/$&;=()+,![]{}'`/%25PATH%25", "http://localhost").pathname;
const agentId = "runner";
const sessionKey = `agent:${agentId}:main-'"$&;|<>^()%![]{}\\\`-%PATH%`;

const sessionsListResponse = () => ({
  owners: [
    { type: "human" as const, id: "profile-ada", label: "Ada" },
    { type: "human" as const, id: "profile-bob", label: "Bob" },
  ],
  ...chatSessionListResponse([
    {
      agentId,
      key: sessionKey,
      kind: "direct",
      label: "Terminal continuation",
      sessionId: "session-terminal-continuation",
      owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
      updatedAt: Date.now(),
    },
  ]),
});

const sharedManagementActions = [
  "Pin session",
  "Mark as unread",
  "Rename…",
  "Advanced",
  "Copy link",
  "Assign to…",
  "Move to group",
  "Archive session",
] as const;
async function openTerminalSession(page: Page) {
  const gateway = await installMockGateway(page, {
    basePath,
    featureMethods: [
      "chat.startup",
      "sessions.assignOwner",
      "sessions.groups.put",
      "sessions.patch",
    ],
    historyMessages: [],
    methodResponses: { "sessions.list": sessionsListResponse() },
    operatorScopes: ["operator.read", "operator.write"],
    presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
    sessionKey,
  });
  await page.goto(
    controlUiSessionUrl(new URL(`${basePath}/`, suite.server.baseUrl).href, sessionKey),
  );
  const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
  // A retained boot pane may render the same history: bind to this session first.
  await expect
    .poll(() => activePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
    .toBe(sessionKey);
  return {
    gateway,
    menuTrigger: activePane.getByRole("button", { name: "Actions for Terminal continuation" }),
    dropdown: activePane.locator("openclaw-chat-header-session-menu"),
  };
}

async function expectAdvancedItems(dropdown: Locator) {
  for (const label of ["Fork conversation", "Icon & color", "Copy details", "Open in", "Delete…"]) {
    await dropdown.getByRole("menuitem", { name: label, exact: true }).waitFor();
  }
}

suite.define(() => {
  it("shows, copies, and retires a credential-free exact continuation command", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ context, page }) => {
        const pageUrl = new URL(suite.server.baseUrl);
        const gatewayUrl = `ws://${pageUrl.host}${basePath}`;
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: pageUrl.origin,
        });
        const { gateway, menuTrigger, dropdown } = await openTerminalSession(page);
        await waitForControlUiRoute(page, {
          routeId: "chat",
          pathname: controlUiSessionPath(sessionKey, basePath),
          pathnamePrefix: `${basePath}/chat/`,
          search: "",
          hash: "",
        });

        await polledAttribute(menuTrigger, "aria-expanded").toBe("false");
        await menuTrigger.press("Enter");
        for (const label of sharedManagementActions) {
          await dropdown.getByText(label, { exact: true }).waitFor({ state: "visible" });
        }
        await openSessionMenuSubmenu(page, "Advanced");
        await expectAdvancedItems(dropdown);
        await openSessionMenuSubmenu(page, "Open in");
        const action = dropdown.getByText("Continue in terminal…", { exact: true });
        await action.waitFor({ state: "visible" });
        await action.click();

        const dialog = page.locator("openclaw-modal-dialog.continue-in-terminal-dialog");
        await dialog.waitFor({ state: "visible" });
        await action.waitFor({ state: "hidden" });
        const command = (await dialog.locator("code").textContent()) ?? "";
        expect(command).toMatch(/^openclaw resume --handoff [A-Za-z0-9_-]+$/u);
        const encoded = command.slice("openclaw resume --handoff ".length);
        expect(decodeResumeHandoff(encoded)).toEqual({
          version: 1,
          sessionKey,
          gatewayUrl,
        });
        expect(await dialog.textContent()).not.toMatch(/--token|--password|bootstrap/i);
        await exactButton(dialog, "Copy command").click();
        await polledClipboard(page).toBe(command);

        await dialog.getByRole("button", { name: "Close" }).click();
        await menuTrigger.press("Enter");
        await openSessionMenuSubmenu(page, "Advanced");
        await openSessionMenuSubmenu(page, "Open in");
        await action.click();
        await dialog.waitFor({ state: "visible" });
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1001, "continue-in-terminal reconnect proof");
        await dialog.waitFor({ state: "detached", timeout: 10_000 });
        await expect
          .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
          .toBeGreaterThan(socketCount);
      },
    );
  });

  it("keeps the canonical session actions reachable in the mobile header menu", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
      },
      async ({ page }) => {
        const { menuTrigger, dropdown } = await openTerminalSession(page);

        await waitForControlUiRoute(page, { routeId: "chat" });

        await menuTrigger.click();
        await polledAttribute(menuTrigger, "aria-expanded").toBe("true");
        for (const label of [
          "Pin session",
          "Mark as unread",
          "Rename",
          "Advanced",
          "Copy",
          "Assign to",
          "Move to group",
          "Archive session",
        ]) {
          await dropdown.getByText(label, { exact: true }).waitFor({ state: "visible" });
        }
        await dropdown.getByRole("menuitem", { name: "Copy", exact: true }).click();
        for (const label of [
          "Copy link",
          "Copy preview link",
          "Copy session ID",
          "Copy as Markdown",
        ]) {
          await dropdown.getByRole("menuitem", { name: label, exact: true }).waitFor();
        }
        await page.keyboard.press("Escape");
        await dropdown.getByRole("menuitem", { name: "Advanced", exact: true }).click();
        const advanced = page.locator(
          '.chat-mobile-host__page[data-mobile-page="session-advanced"]',
        );
        for (const label of [
          "Fork conversation",
          "Icon & color",
          "Delete",
          "Continue in terminal",
        ]) {
          await advanced.getByRole("button", { name: label, exact: true }).waitFor();
        }
        const host = page.locator(".chat-mobile-host");
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Back", exact: true })
          .click();
        await host.locator('.chat-mobile-details-page[data-details-page="root"]').waitFor();
        await closeChatDetails(page);
        await menuTrigger.click();
        await dropdown.getByRole("menuitem", { name: "Advanced", exact: true }).click();
        await advanced.getByRole("button", { name: "Continue in terminal", exact: true }).click();
        await page
          .locator("openclaw-modal-dialog.continue-in-terminal-dialog")
          .waitFor({ state: "visible" });
      },
    );
  });
});
