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
        const identity = panel.locator(".chat-processes__identity");
        expect(await identity.getAttribute("title")).toBe(name);
        const inspect = () =>
          identity.evaluate((el) => {
            const text = el.querySelector("bdi")!.firstChild!;
            const range = document.createRange();
            const value = text.textContent!;
            const box = el.getBoundingClientRect();
            const fits = (start: number, end: number) => {
              range.setStart(text, start);
              range.setEnd(text, end);
              const rect = range.getBoundingClientRect();
              return rect.left >= box.left - 1 && rect.right <= box.right + 1;
            };
            return {
              ending: fits(value.lastIndexOf("/") + 1, value.length),
              prefix: fits(0, 10),
              height: box.height,
              line: Number.parseFloat(getComputedStyle(el).lineHeight),
            };
          });
        const initial = await inspect();
        expect(initial.ending).toBe(true);
        expect(initial.height).toBeLessThanOrEqual(initial.line + 1);
        await identity.hover();
        await page.mouse.wheel(-2000, 0);
        await expect.poll(async () => (await inspect()).prefix).toBe(true);
        await page.mouse.wheel(2000, 0);
        await expect.poll(async () => (await inspect()).ending).toBe(true);

        for (const line of ["Survey line 1", "Survey line 28"]) {
          if (line === "Survey line 28") {
            await output.focus();
            await output.press("End");
          }
          await expect
            .poll(() =>
              output.evaluate((e, expected) => {
                const pre = e.querySelector("pre")!;
                const node = pre.firstChild!;
                const start = node.textContent!.indexOf(expected);
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, start + expected.length);
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
