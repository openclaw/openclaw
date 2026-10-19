import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { expectCount, setVisibility, showText } from "./activity-assertions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Activity summaries mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("collects only while Live activity is visible and releases its roster on navigation", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:research:work";
      const gateway = await installMockGateway(page, {
        sessions: [{ key: sessionKey, kind: "direct", hasActiveRun: true, status: "running" }],
      });
      const emitTool = (id: string) =>
        gateway.emitGatewayEvent("session.tool", {
          stream: "tool",
          runId: `run-${id}`,
          sessionKey,
          data: { phase: "result", name: "read", toolCallId: id, result: { text: `${id} output` } },
        });
      const navigate = (route: "activity" | "config") =>
        evaluateControlUiContext(
          page,
          (context, routeId) => {
            context.navigate(routeId, routeId === "activity" ? { search: "?view=live" } : {});
          },
          route,
        );
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
      await setVisibility(page, "hidden");
      await gateway.waitForRequest("sessions.messages.unsubscribe", { match: { key: sessionKey } });
      await emitTool("hidden");
      await setVisibility(page, "visible");
      await expect
        .poll(() => gateway.getRequests("sessions.messages.subscribe", { key: sessionKey }))
        .toHaveLength(2);
      await emitTool("visible-again");
      await expectCount(page.locator(".activity-entry")).toBe(2);
      await page.getByRole("button", { name: "Expand all", exact: true }).click();
      await showText(page, "visible-again output");
      expect(await page.getByText("hidden output", { exact: true }).count()).toBe(0);
      await navigate("config");
      await waitForControlUiSettingsTakeover(page);
      await page.locator("openclaw-activity-page").waitFor({ state: "detached" });
      await expect
        .poll(() => gateway.getRequests("sessions.messages.unsubscribe", { key: sessionKey }))
        .toHaveLength(2);
      await emitTool("while-away");
      await navigate("activity");
      await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
      await page.locator(".activity-empty").waitFor();
      expect(await page.locator(".activity-entry").count()).toBe(0);
      expect(await gateway.getSocketCount()).toBe(1);
    });
  });

  it("updates one visible tool summary from running to completed output", async () => {
    const videoDir = path.join(suite.artifactDir, "video");
    const viewport = { height: 900, width: 1280 };
    if (captureUiProof) {
      await mkdir(videoDir, { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        recordVideo: captureUiProof ? { dir: videoDir, size: viewport } : undefined,
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [
            { key: "agent:main:main", kind: "direct", hasActiveRun: true, status: "running" },
          ],
        });
        const startedAt = Date.now();
        const tool = { runId: "run-diagnostics", stream: "tool", sessionKey: "agent:main:main" };
        const call = { name: "web_search", toolCallId: "tool-diagnostics" };
        const output = "Indexed 3 diagnostic sources.";

        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await page.locator(".activity-empty").waitFor();
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: "agent:main:main" },
        });

        const entry = page.locator(".activity-entry").filter({ hasText: "web_search" });
        const summary = entry.locator(".activity-entry__summary .activity-entry__text");
        for (const [index, data] of [
          { phase: "start", args: { query: "operator diagnostics" } },
          { phase: "result", result: { content: [{ type: "text", text: output }] } },
        ].entries()) {
          await gateway.emitGatewayEvent("agent", {
            ...tool,
            seq: index + 1,
            ts: startedAt + index * 250,
            data: { ...call, ...data },
          });
          await showText(entry, index === 0 ? "Running" : "Done");
          await expectCount(page.locator(".activity-entry")).toBe(1);
          if (index === 0) {
            await showText(summary, "1 argument hidden");
          }
        }
        await showText(page, "1 of 1");
        await entry.locator("summary").click();
        await showText(entry, output);
        await showText(entry, "Run: run-diagnostics");

        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, "completed-tool-summary.png"),
            await takeControlUiViewportScreenshot(page, entry, [
              entry.getByText(output, { exact: true }),
            ]),
          );
        }
      },
    );
  });
});
