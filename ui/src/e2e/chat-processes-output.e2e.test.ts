import { expect, it } from "vitest";
import { openChatPanels } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Retained process output",
  startServerBeforeBrowser: true,
});
const name =
  "/workspace/coastal-survey/release-tools/retained-output-verification/field-equipment-calibration/portable-monitoring-station/bin/verify-sampling-manifest";
suite.define(() => {
  it("reads the first and last lines of a completed process at enlarged text in a phone sheet", async () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const base = suite.server.baseUrl;
        const gateway = await installMockGateway(
          page,
          {
            sessionKey: "agent:main:main",
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.processes.list"],
            methodResponses: {
              "sessions.processes.list": {
                sessionId: "review",
                truncated: false,
                processes: [
                  {
                    processId: "survey",
                    instanceId: "survey-1",
                    name,
                    status: "failed",
                    startedAt: 1000,
                    endedAt: 2000,
                    canStop: false,
                    truncated: true,
                    exitCode: 1,
                    exitReason: "overall-timeout",
                    tail: Array.from({ length: 28 }, (_, i) => "Survey line " + (i + 1)).join("\n"),
                  },
                ],
              },
            },
          },
          {
            afterInitScript:
              ";localStorage.setItem(" +
              JSON.stringify(controlUiBundledSettingsStorageKey(base)) +
              "," +
              JSON.stringify(JSON.stringify({ textScale: 140 })) +
              ");",
          },
        );
        await page.goto(base + "chat/main");
        await openChatPanels(page, "mobile");
        await page
          .locator(".chat-mobile-host:not([hidden])")
          .getByRole("button", { name: "Processes", exact: true })
          .click();
        const panel = page.locator("openclaw-chat-processes-panel:visible");
        await panel.getByRole("button", { name: /Finished/ }).tap();
        const open = panel.getByRole("button", { name, exact: true });
        await open.press("Enter");
        const output = panel.getByLabel("Recent output", { exact: true });
        await output.waitFor();
        for (const line of ["Survey line 1", "Survey line 28"]) {
          if (line === "Survey line 28") {
            await output.focus();
            await output.press("End");
          }
          await expect
            .poll(() =>
              output.evaluate((e, line) => {
                const pre = e.querySelector("pre")!;
                const node = pre.firstChild!;
                const start = node.textContent!.indexOf(line);
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, start + line.length);
                const rect = range.getBoundingClientRect();
                return pre.contains(
                  document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2),
                );
              }, line),
            )
            .toBe(true);
        }
        await panel.getByRole("button", { name: "Back to processes" }).press("Enter");
        expect(await open.evaluate((e) => e === document.activeElement)).toBe(true);
        expect(await gateway.getRequests("sessions.processes.stop")).toHaveLength(0);
      },
    ));
});
