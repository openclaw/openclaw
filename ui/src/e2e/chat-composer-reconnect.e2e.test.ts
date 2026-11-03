import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer reconnect" });

suite.define(() => {
  it("retains the known effort and session menu while reconnecting", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("composer-reconnect", artifactRoot)
      : undefined;
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const levels = [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "example/reasoner",
          historyMessages: [
            {
              role: "user",
              __openclaw: { senderId: "alex", senderIdentity: { type: "profile", id: "alex" } },
              content: "Review the reconnect behavior and keep the selected effort.",
              timestamp: 1,
            },
            {
              role: "assistant",
              content: "The session uses High effort. I am checking the connection transition.",
              timestamp: 2,
            },
            {
              role: "user",
              __openclaw: {
                senderId: "blair",
                senderName: "Blair",
                senderIdentity: { type: "profile", id: "blair" },
              },
              content: "I will check that the session controls remain available too.",
              timestamp: 3,
            },
          ],
          methodResponses: {
            "users.self": {
              profile: { id: "alex", displayName: "Alex", emails: [], updatedAt: 1 },
            },
          },
          models: [
            {
              id: "reasoner",
              name: "Reasoner",
              provider: "example",
              reasoning: true,
              thinkingLevels: levels,
            },
          ],
          sessions: [
            {
              key: "agent:main:main",
              sessionId: "session:agent:main:main",
              label: "Reconnect review",
              kind: "direct",
              updatedAt: 1,
              model: "reasoner",
              modelProvider: "example",
              thinkingLevel: "high",
              thinkingLevels: levels,
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input").first();
        const model = composer.locator("[data-chat-model-select]");
        const effort = composer.locator("[data-chat-thinking-select]");
        const sender = page.locator(".chat-group.user .chat-sender-name").first();
        const menu = page.locator(".chat-header-session-menu__trigger").first();
        await expect.poll(() => effort.textContent()).toContain("High");
        await expect.poll(() => effort.isVisible()).toBe(true);
        await expect.poll(() => menu.isVisible()).toBe(true);
        await expect.poll(() => sender.textContent()).toBe("Alex");
        const capture = async (name: string) => {
          if (!artifactDir) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("body"),
            [composer, menu],
            {
              elements: [composer],
              animations: "disabled",
            },
          );
          await writeFile(`${artifactDir}/${name}.png`, frame.png);
          await writeFile(`${artifactDir}/${name}-composer.png`, frame.elements[0]!.png);
        };
        await capture("connected");
        expect(await effort.textContent()).toContain("High");
        expect(await sender.textContent()).toBe("Alex");
        const before = await effort.boundingBox();
        await gateway.setOnline(false);
        await page.waitForFunction(
          () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
        );
        await capture("reconnecting");
        expect(await effort.isVisible()).toBe(true);
        expect(await effort.textContent()).toContain("High");
        expect(await menu.isVisible()).toBe(true);
        expect(await sender.textContent()).toBe("Alex");
        expect(await effort.getAttribute("aria-disabled")).toBe("true");
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await effort.boundingBox()).toEqual(before);
        const writes = (await gateway.getRequests("sessions.patch")).length;
        await effort.click();
        await page.keyboard.press("Home");
        expect((await gateway.getRequests("sessions.patch")).length).toBe(writes);
        await page.keyboard.press("Escape");
        await gateway.setOnline(true);
        await page.waitForFunction(
          () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
        );
        await expect.poll(() => effort.getAttribute("aria-disabled")).toBe("false");
        expect(await effort.textContent()).toContain("High");
        await capture("reconnected");
      },
    );
  });
});
