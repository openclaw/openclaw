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
  captureUiProof,
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
    "remembers authenticated Access and enabled or disabled Fast mode with reasoning across new sessions (%s)",
    async (source) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(controlUiBundledGatewayUrl(suite.server.baseUrl))}`;
      let entries: Record<string, unknown> = { "new-session.migration.v1": true };
      let page!: Page;
      let gateway!: MockGatewayControls;
      let preferenceWrites = 0;
      let expectedAccess = "daybreak_blue";

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
              cyberAccessProgramDefault: "standard",
              availableAccessPrograms: { cyber: ["standard", "daybreak_blue", "daybreak_red"] },
            },
          ],
          ...(source === "identity"
            ? { presenceUsers: [{ self: true, id: "sample-user", name: "Sample User" }] }
            : {}),
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.create",
            "sessions.patch",
            ...(source === "identity" ? ["users.prefs.get", "users.prefs.set"] : []),
          ],
          sessions: [],
          methodResponses: {
            "users.prefs.get": { status: "ok", entries },
            "users.prefs.set": { status: "ok" },
            "sessions.create": {
              key: "agent:main:fast-mode-proof",
              runStarted: true,
              entry: {
                model: "gpt-4.1",
                modelProvider: "openai",
                cyberAccessProgram: source === "identity" ? expectedAccess : "standard",
              },
            },
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
        if (source === "identity") {
          await pollAttribute(
            page.locator(`[data-chat-access-option="${expectedAccess}"]`),
            "aria-pressed",
          ).toBe("true");
        }
      };
      const submit = async (message: string, fastMode: boolean) => {
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session" }).click();
        expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
          fastMode,
          thinkingLevel: "high",
          cyberAccessProgram: source === "identity" ? expectedAccess : "standard",
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
        const access = page.locator('[data-chat-access-option="daybreak_blue"]');
        if (source === "identity") {
          await page.getByRole("switch", { name: "Daybreak", exact: true }).check();
          await pollAttribute(access, "aria-pressed").toBe("true");
          await confirmPreferenceWrite({
            cyberAccessProgram: "daybreak_blue",
            daybreakAccessProgram: "daybreak_blue",
          });
        }
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        await captureUiProof(suite, page, `access-${source}-new.png`);
        await submit("First session", true);
        await waitForCommittedChatRoute(page);
        await openEffort();
        if (source === "identity") {
          await pollAttribute(access, "aria-pressed").toBe("true");
        }
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        await captureUiProof(suite, page, `access-${source}-chat.png`);
        if (source === "identity") {
          await page.locator('[data-chat-access-option="daybreak_red"]').click();
          await gateway.waitForRequest("sessions.patch", {
            match: { cyberAccessProgram: "daybreak_red" },
          });
          await confirmPreferenceWrite({
            cyberAccessProgram: "daybreak_red",
            daybreakAccessProgram: "daybreak_red",
          });
          expectedAccess = "daybreak_red";
          const savedSession = await gateway.getSessionRow("agent:main:fast-mode-proof");
          expect(savedSession.cyberAccessProgram).toBe("daybreak_red");
          await gateway.setSessionsListResponse({ sessions: [savedSession] });
          await page.reload();
          await openEffort();
          await pollAttribute(
            page.locator('[data-chat-access-option="daybreak_red"]'),
            "aria-pressed",
          ).toBe("true");
        }

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
