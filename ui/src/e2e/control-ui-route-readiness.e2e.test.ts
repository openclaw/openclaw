import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI route readiness" });
const backgroundMethods = ["cron.list", "cron.status", "system.info"];
const readSelection = (composer: Locator) =>
  composer.evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection,
  }));

suite.define(() => {
  it.each([
    ["desktop selection", 1200, 800, "no-preference", false],
    ["mobile selection", 390, 844, "reduce", false],
    ["mobile composition", 390, 844, "reduce", true],
  ] as const)(
    "accepts a message and preserves the next draft's %s while first history loads",
    async (_name, width, height, reducedMotion, ime) => {
      const options = { viewport: { width, height }, reducedMotion };
      await suite.withPage(options, async ({ page, context }) => {
        const sessionKey = "agent:main:thread:12345678-90ab-4def-8234-567890abcdef";
        const sessionId = "session:history-ready";
        const activeLeafEntryId = "history-ready-leaf";
        const submittedMessage = "Send before history.";
        if (width > 400) {
          const scope = gatewayOriginScope(suite.server.baseUrl.replace(/^http/u, "ws"));
          await page.addInitScript(
            (key) => localStorage.setItem(key, "involving-me"),
            `openclaw.control.sidebarSessionOwnerFilter.v1:${scope}:history-profile`,
          );
        }
        const gateway = await installMockGateway(page, {
          sessionKey,
          ...(width > 400
            ? {
                presenceUsers: [{ self: true, id: "history-profile", name: "Fixture user" }],
                featureMethods: [...defaultControlUiFeatureMethods, "system.info"],
                methodResponses: {
                  "config.get": { config: {}, hash: "history-profile-config" },
                  "system.info": { platform: "darwin" },
                },
              }
            : {}),
          sessions: [
            {
              key: sessionKey,
              sessionId,
              activeLeafEntryId,
              kind: "direct",
              updatedAt: 1,
              displayName: "Draft timing",
              hasActiveRun: false,
            },
          ],
          historyMessages: [{ role: "assistant", content: "Ready." }],
          heldMethods: ["chat.startup", "chat.history"],
        });
        const hasInvolvingMeRequest = async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => requireRecord(request.params).involvingMe === true,
          );
        await page.goto(`${suite.server.baseUrl}chat/main/draft-timing-12345678`);
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await expect.poll(() => pane.locator(".loading-skeleton").isVisible()).toBe(true);
        expect(await composer.evaluate((el) => el === document.activeElement)).toBe(false);
        await composer.fill(submittedMessage);
        await expect.poll(() => pane.locator(".chat-send-btn--send").isEnabled()).toBe(true);
        if (width > 400) {
          await composer.press("Enter");
        } else {
          await pane.getByRole("button", { name: "Send message" }).click();
        }
        await expect.poll(() => composer.inputValue()).toBe("");
        await pane.locator(".chat-queue").getByText(submittedMessage, { exact: true }).waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await pane.locator(".loading-skeleton").isVisible()).toBe(true);

        await composer.fill("Next draft before history.");
        const input = await composer.elementHandle();
        let pendingDraft = await composer.inputValue();
        await composer.evaluate((element: HTMLTextAreaElement) =>
          element.setSelectionRange(6, 13, "backward"),
        );
        const cdp = ime ? await context.newCDPSession(page) : null;
        if (cdp) {
          await cdp.send("Input.imeSetComposition", {
            text: "編集中",
            selectionStart: 1,
            selectionEnd: 2,
          });
          pendingDraft = await composer.inputValue();
          expect(pendingDraft).toContain("編集中");
        }
        const selection = await readSelection(composer);
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
        );
        const before = await composer.boundingBox();

        if (width > 400) {
          expect(await hasInvolvingMeRequest()).toBe(false);
          for (const method of backgroundMethods) {
            expect(await gateway.getRequests(method)).toHaveLength(0);
          }
        }
        await gateway.resolveDeferred("chat.startup");
        await expect.poll(() => pane.locator(".loading-skeleton").count()).toBe(0);
        await expect.poll(() => pane.textContent()).toContain("Ready.");
        expect(
          await input!.evaluate(
            (element) => element.isConnected && element === document.activeElement,
          ),
        ).toBe(true);
        expect(await composer.inputValue()).toBe(pendingDraft);
        expect(await readSelection(composer)).toEqual(selection);
        const after = await composer.boundingBox();
        expect(after?.x).toBeCloseTo(before!.x, 0);
        expect(after?.y).toBeCloseTo(before!.y, 0);
        expect(after?.width).toBeCloseTo(before!.width, 0);
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey,
          sessionId,
          expectedLeafEntryId: activeLeafEntryId,
          message: submittedMessage,
        });
        if (cdp) {
          await cdp.send("Input.insertText", { text: "編集済み" });
          pendingDraft = await composer.inputValue();
          expect(pendingDraft).toContain("編集済み");
          await cdp.detach();
        }
        expect(await composer.inputValue()).toBe(pendingDraft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        if (width > 400) {
          await expect.poll(hasInvolvingMeRequest).toBe(true);
          await Promise.all(backgroundMethods.map((method) => gateway.waitForRequest(method)));
          expect(await composer.inputValue()).toBe(pendingDraft);
        }
      });
    },
  );

  it.each([
    { name: "root", basePath: "" },
    { name: "encoded mount", basePath: "/nested/$&;=()+,![]{}'`/%25PATH%25" },
  ])("navigates exact session keys at the $name", async ({ basePath }) => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const initialSessionKey = "agent:runner:route:initial";
      const mountUrl = new URL(suite.server.baseUrl);
      mountUrl.pathname = basePath || "/";
      await installMockGateway(page, {
        basePath: basePath ? mountUrl.pathname : "",
        sessionKey: initialSessionKey,
      });
      await page.goto(controlUiSessionUrl(mountUrl.href, initialSessionKey));
      const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      await expect
        .poll(() => visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
        .toBe(initialSessionKey);

      const encodedBase = basePath ? mountUrl.pathname : "";
      for (const [rest, suffix] of [
        ["a/b", "a%2Fb"],
        ["a:b", "a/b"],
        ["%2F%25%3F%23", "%252F%2525%253F%2523"],
        ["a?b#c", "a%3Fb%23c"],
      ]) {
        const sessionKey = `agent:runner:route:${rest}`;
        await navigateToControlUiSession(page, sessionKey);
        expect(new URL(page.url()).pathname).toBe(`${encodedBase}/chat/runner/route/${suffix}`);
        expect(await visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey)).toBe(
          sessionKey,
        );
      }
    });
  });
});
