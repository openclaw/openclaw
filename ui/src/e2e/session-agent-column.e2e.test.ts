import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session agent column" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function selectAgentScope(page: Page, name: string) {
  const control = page.locator(".sessions-hub-header .agent-scope-control openclaw-agent-select");
  await control.locator(".agent-select__trigger").click();
  await control
    .locator(".agent-select__option[data-agent-option]")
    .filter({ hasText: name })
    .evaluate((option) => (option as HTMLElement).click());
  await page.locator(".agent-select__menu").waitFor({ state: "hidden" });
}

suite.define(() => {
  it.each([1440, 390])(
    "shows Agent only in the all-agent sessions table at %i px",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, locale: "en-US" },
        async ({ page }) => {
          await installMockGateway(page, {
            sessionKey: "unknown",
            methodResponses: {
              "agent.identity.get": {
                cases: [
                  {
                    match: { agentId: "research" },
                    response: {
                      agentId: "research",
                      name: "Research",
                      avatar: "/test-agent-avatar.png",
                      emoji: "🔬",
                    },
                  },
                  { response: { agentId: "main", name: "Assistant", avatar: "" } },
                ],
              },
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: [
                  { id: "main", name: "Assistant" },
                  {
                    id: "research",
                    name: "Research",
                    identity: { avatar: "/test-agent-avatar.png", emoji: "🔬" },
                  },
                ],
              },
              "sessions.list": {
                count: 2,
                defaults: { contextTokens: null, model: null, modelProvider: null },
                path: "",
                sessions: [
                  { key: "agent:main:main", kind: "direct", label: "Planning", updatedAt: 2 },
                  { key: "agent:research:brief", kind: "direct", label: "Brief", updatedAt: 1 },
                ],
                ts: 3,
              },
            },
          });
          await page.route("**/test-agent-avatar.png", (route) =>
            route.fulfill({
              contentType: "image/png",
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAArElEQVR4nGP8sNaIgRSgdqaNJPVMDDQGTKMWEAKjQUQQsDAQDfiDzjIwMLwMgnLFq3YSo4uRmIzGDzYaKyBoDRMlpjMwMLxsc6fIAn68phNjBxOFphO0Y+DyAT/RzsfvidGcTBAMXBB9XGdMkkHiOLL0gEbyR6I9gadEIuCDj0TYgb+8IxxEH/HaQbA0Jao++Ai2Ay1vE1kfkFDhfARbM9rwojpgor6RDMPMAgDX5isaKdTxAwAAAABJRU5ErkJggg==",
                "base64",
              ),
            }),
          );
          await page.goto(`${suite.server.baseUrl}sessions`);
          const table = page.locator(".sessions-table");
          await table.locator(".session-data-row").first().waitFor();

          await selectAgentScope(page, "Assistant");
          await expect
            .poll(() => table.locator("thead th").allTextContents())
            .toEqual(["", "Session", "Updated", "Actions"]);
          expect(await table.locator(".session-data-row .agent-row-chip").count()).toBe(0);
          if (captureUiProof) {
            await writeFile(
              path.join(suite.artifactDir, `sessions-agent-scoped-${width}.png`),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
            );
          }

          await selectAgentScope(page, "All agents");
          await expect
            .poll(() => table.locator("thead th").allTextContents())
            .toEqual(["", "Session", "Agent", "Updated", "Actions"]);
          await expect
            .poll(() => table.locator(".session-agent-col .agent-row-chip").count())
            .toBe(2);
          expect(await table.locator(".session-agent-col [data-agent-id='research']").count()).toBe(
            1,
          );
          expect(await table.locator(".session-key-cell .agent-row-chip").count()).toBe(0);
          const avatar = table.locator("[data-agent-id='research'] .agent-row-chip__avatar");
          const image = avatar.locator("img");
          await expect
            .poll(() =>
              image.evaluate(
                (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
              ),
            )
            .toBe(true);
          await expect.poll(() => avatar.getAttribute("data-avatar-state")).toBe("loaded");
          if (captureUiProof) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [table],
              {
                elements: [avatar],
                animations: "disabled",
              },
            );
            await writeFile(
              path.join(suite.artifactDir, `sessions-all-agents-${width}.png`),
              frame.png,
            );
            await writeFile(
              path.join(suite.artifactDir, `agent-avatar-${width}.png`),
              frame.elements[0]!.png,
            );
          }
          const avatarBounds = await avatar.boundingBox();
          const imageBounds = await image.boundingBox();
          expect(imageBounds?.x).toBeCloseTo(avatarBounds!.x, 1);
          expect(imageBounds?.y).toBeCloseTo(avatarBounds!.y, 1);
          expect(imageBounds?.width).toBeCloseTo(avatarBounds!.width, 1);
          expect(imageBounds?.height).toBeCloseTo(avatarBounds!.height, 1);
        },
      );
    },
  );
});
