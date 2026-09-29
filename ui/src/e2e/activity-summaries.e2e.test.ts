import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Activity summaries mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
type ActivityApp = HTMLElement & { runtime: { context: ApplicationContext } };
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-activity-summaries");
  }
});

suite.define(() => {
  it("collects only while Live activity is visible and releases its roster on navigation", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:research:work";
      const gateway = await installMockGateway(page, {
        sessions: [
          {
            key: sessionKey,
            agentId: "research",
            kind: "direct",
            displayName: "Research",
            hasActiveRun: true,
            status: "running",
            updatedAt: Date.now(),
          },
        ],
      });
      const emitTool = (id: string) =>
        gateway.emitGatewayEvent("session.tool", {
          stream: "tool",
          runId: `run-${id}`,
          sessionKey,
          data: { phase: "result", name: "read", toolCallId: id, result: { text: `${id} output` } },
        });
      const navigate = (route: "activity" | "config") =>
        page.evaluate((routeId) => {
          const app = document.querySelector<ActivityApp>("openclaw-app");
          if (!app) {
            throw new Error("Control UI app is unavailable");
          }
          app.runtime.context.navigate(
            routeId,
            routeId === "activity" ? { search: "?view=live" } : {},
          );
        }, route);
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("connect");
      await emitTool("before-open");
      await navigate("activity");
      await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
      await gateway.waitForRequest("sessions.messages.subscribe", { match: { key: sessionKey } });
      await page.locator(".activity-empty").waitFor();
      expect(await page.locator(".activity-entry").count()).toBe(0);
      await emitTool("visible");
      await page.locator(".activity-entry").waitFor();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await gateway.waitForRequest("sessions.messages.unsubscribe", { match: { key: sessionKey } });
      await emitTool("hidden");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("sessions.messages.subscribe", { key: sessionKey })).length,
        )
        .toBe(2);
      await emitTool("visible-again");
      await expect.poll(() => page.locator(".activity-entry").count()).toBe(2);
      await page.getByRole("button", { name: "Expand all", exact: true }).click();
      await page.getByText("visible-again output", { exact: true }).waitFor();
      expect(await page.getByText("hidden output", { exact: true }).count()).toBe(0);
      await navigate("config");
      await waitForControlUiSettingsTakeover(page);
      await page.locator("openclaw-activity-page").waitFor({ state: "detached" });
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("sessions.messages.unsubscribe", { key: sessionKey }))
              .length,
        )
        .toBe(2);
      await emitTool("while-away");
      await navigate("activity");
      await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
      await page.locator(".activity-empty").waitFor();
      expect(await page.locator(".activity-entry").count()).toBe(0);
      expect(await gateway.getSocketCount()).toBe(1);
    });
  });

  it("updates one visible tool summary from running to completed output", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [
            { key: "agent:main:main", kind: "direct", hasActiveRun: true, status: "running" },
          ],
        });
        const startedAt = Date.now();

        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await page.locator(".activity-empty").waitFor();
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: "agent:main:main" },
        });

        await gateway.emitGatewayEvent("agent", {
          runId: "run-diagnostics",
          seq: 1,
          stream: "tool",
          ts: startedAt,
          sessionKey: "agent:main:main",
          data: {
            phase: "start",
            name: "web_search",
            toolCallId: "tool-diagnostics",
            args: { query: "operator diagnostics" },
          },
        });

        const entry = page.locator(".activity-entry").filter({ hasText: "web_search" });
        await entry.waitFor();
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
        await entry.getByText("Running", { exact: true }).waitFor();
        await entry
          .locator(".activity-entry__summary .activity-entry__text")
          .getByText("1 argument hidden", { exact: true })
          .waitFor();

        await gateway.emitGatewayEvent("agent", {
          runId: "run-diagnostics",
          seq: 2,
          stream: "tool",
          ts: startedAt + 250,
          sessionKey: "agent:main:main",
          data: {
            phase: "result",
            name: "web_search",
            toolCallId: "tool-diagnostics",
            result: {
              content: [{ type: "text", text: "Indexed 3 diagnostic sources." }],
            },
          },
        });

        await entry.getByText("Done", { exact: true }).waitFor();
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
        await page.getByText("1 of 1", { exact: true }).waitFor();
        await entry.locator("summary").click();
        await entry.getByText("Indexed 3 diagnostic sources.", { exact: true }).waitFor();
        await entry.getByText("Run: run-diagnostics", { exact: true }).waitFor();

        if (captureUiProof) {
          await writeFile(
            path.join(proofDir, "completed-tool-summary.png"),
            await takeControlUiViewportScreenshot(page, entry, [
              entry.getByText("Indexed 3 diagnostic sources.", { exact: true }),
            ]),
          );
        }
      },
    );
  });
});
