import path from "node:path";
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
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
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
        await page.locator("[data-chat-speed-toggle]").waitFor({ state: "visible" });
        return effort;
      };
      const confirmPreferenceWrite = async (selection: Record<string, unknown>) => {
        if (source === "identity") {
          const request = await gateway.waitForRequest("users.prefs.set", {
            after: preferenceWrites,
          });
          preferenceWrites += 1;
          const params = request.params;
          if (!isRecord(params) || !isRecord(params.entries)) {
            throw new Error("Expected preference-write entries");
          }
          expect(params).toMatchObject({ entries: { [preferenceKey]: selection } });
          entries = { ...entries, ...params.entries };
          await gateway.setMethodResponse("users.prefs.get", { status: "ok", entries });
        }
      };
      const capture = async (name: string) => {
        if (captureUiProofEnabled && source === "browser") {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, name),
          });
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
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        await confirmPreferenceWrite({ thinkingLevel: "high" });

        await page.locator("[data-chat-speed-toggle]").click();
        await expect
          .poll(() => page.locator("[data-chat-speed-toggle]").getAttribute("aria-checked"))
          .toBe("true");
        await capture("01-fast-mode-selected.png");
        await confirmPreferenceWrite({ fastMode: true });
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill("First session");
        await page.getByRole("button", { name: "Start session" }).click();
        expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
          fastMode: true,
          thinkingLevel: "high",
          message: "First session",
        });
        await waitForCommittedChatRoute(page);

        // A new document must recover preferences, not retain the old controller's fields.
        // Identity-backed recovery must also work without its browser projection.
        if (source === "identity") {
          await page.evaluate((key) => localStorage.removeItem(key), storageKey);
        }
        await page.close();
        await openPage();
        const restoredEffort = await openEffort();
        await expect
          .poll(() => restoredEffort.getAttribute("data-chat-thinking-value"))
          .toBe("high");
        await capture("02-next-session-restored.png");
        await expect
          .poll(() => page.locator("[data-chat-speed-toggle]").getAttribute("aria-checked"))
          .toBe("true");

        await page.locator("[data-chat-speed-toggle]").click();
        await expect
          .poll(() => page.locator("[data-chat-speed-toggle]").getAttribute("aria-checked"))
          .toBe("false");
        await confirmPreferenceWrite({ fastMode: false });
        if (source === "identity") {
          await page.evaluate((key) => localStorage.removeItem(key), storageKey);
        }
        await page.close();
        await openPage();
        const disabledEffort = await openEffort();
        await expect
          .poll(() => disabledEffort.getAttribute("data-chat-thinking-value"))
          .toBe("high");
        await expect
          .poll(() => page.locator("[data-chat-speed-toggle]").getAttribute("aria-checked"))
          .toBe("false");
        await capture("03-disabled-mode-restored.png");
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill("Standard-speed session");
        await page.getByRole("button", { name: "Start session" }).click();
        expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
          fastMode: false,
          thinkingLevel: "high",
          message: "Standard-speed session",
        });
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
