import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollAttribute,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const thinkingLevels = ["low", "medium", "high"].map((id) => ({ id, label: id }));
const preferenceKey = "new-session.v1:main";

suite.define(() => {
  it.each(["browser", "identity"] as const)(
    "remembers enabled and disabled Fast mode with reasoning across new sessions (%s)",
    async (source) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(controlUiBundledGatewayUrl(suite.server.baseUrl))}`;
      let entries: Record<string, unknown> = { "new-session.migration.v1": true };
      let page!: Page;
      let gateway!: MockGatewayControls;
      let preferenceWrites = 0;

      const openPage = async () => {
        preferenceWrites = 0;
        page = await context.newPage();
        gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          assistantName: "Main",
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              provider: "openai",
              reasoning: true,
              thinkingLevels,
              thinkingDefault: "medium",
            },
          ],
          ...(source === "identity"
            ? { presenceUsers: [{ self: true, id: "sample-user", name: "Sample User" }] }
            : {}),
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.create",
            ...(source === "identity" ? ["users.prefs.get", "users.prefs.set"] : []),
          ],
          sessions: [],
          methodResponses: {
            "users.prefs.get": { status: "ok", entries },
            "users.prefs.set": { status: "ok" },
            "sessions.create": { key: "agent:main:fast-mode-proof", runStarted: true },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
      };
      const openEffort = async () => {
        const effort = page.locator('[data-chat-thinking-select="true"]');
        await effort.click();
        await page.locator('[data-chat-speed-option="on"]').waitFor({ state: "visible" });
        return effort;
      };
      const speed = (value: "on" | "off") => page.locator(`[data-chat-speed-option="${value}"]`);
      const expectSpeed = (value: "on" | "off", checked = "true") =>
        pollAttribute(speed(value), "aria-checked").toBe(checked);
      const reopen = async (enabled: boolean) => {
        // A fresh document must restore identity preferences without the browser projection.
        if (source === "identity") {
          await page.evaluate((key) => localStorage.removeItem(key), storageKey);
        }
        await page.close();
        await openPage();
        await pollAttribute(await openEffort(), "data-chat-thinking-value").toBe("high");
        await expectSpeed("on", String(enabled));
      };
      const submit = async (message: string, fastMode: boolean) => {
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session" }).click();
        expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
          fastMode,
          thinkingLevel: "high",
          message,
        });
      };
      const confirmPreferenceWrite = async (selection: Record<string, unknown>) => {
        if (source === "identity") {
          const { params } = await gateway.waitForRequest("users.prefs.set", {
            after: preferenceWrites++,
          });
          if (!isRecord(params) || !isRecord(params.entries)) {
            throw new Error("Expected preference-write entries");
          }
          expect(params).toMatchObject({ entries: { [preferenceKey]: selection } });
          entries = { ...entries, ...params.entries };
          await gateway.setMethodResponse("users.prefs.get", { status: "ok", entries });
        }
      };

      try {
        await openPage();
        const effort = await openEffort();
        const slider = page.locator('[data-chat-thinking-slider="true"]');
        const highIndex = await slider.evaluate((element) =>
          element.getAttribute("data-chat-thinking-values")!.split(",").indexOf("high"),
        );
        expect(highIndex).toBeGreaterThanOrEqual(0);
        await slider.fill(String(highIndex));
        await pollAttribute(effort, "data-chat-thinking-value").toBe("high");
        await confirmPreferenceWrite({ thinkingLevel: "high" });

        await speed("on").click();
        await expectSpeed("on");
        await confirmPreferenceWrite({ fastMode: true });
        await submit("First session", true);
        await waitForCommittedChatRoute(page);

        await reopen(true);

        await speed("off").click();
        await expectSpeed("off");
        await confirmPreferenceWrite({ fastMode: false });
        await reopen(false);
        await submit("Standard-speed session", false);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
