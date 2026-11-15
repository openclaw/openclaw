import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile Files refresh mocked Gateway E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

async function captureFiles(
  page: import("playwright").Page,
  name: string,
  target: import("playwright").Locator,
) {
  const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [target], {
    animations: "disabled",
    elements: [target],
  });
  await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
  await writeFile(path.join(suite.artifactDir, name + "-panel.png"), frame.elements[0]!.png);
}

suite.define(() => {
  it.each(["empty", "populated", "unavailable", "no-match"])(
    "retains accepted %s Files during a terminal refresh",
    async (kind) => {
      await suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          reducedMotion: "reduce",
          locale: "en-US",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const entries =
            kind === "populated"
              ? Array.from({ length: 30 }, (_, i) => ({
                  kind: "file",
                  name: "file-" + i + ".md",
                  path: "file-" + i + ".md",
                  size: 42,
                }))
              : [];
          const listing = {
            sessionKey: "main",
            root: "/workspace",
            files: [],
            ...(kind === "unavailable" ? {} : { browser: { path: "", entries } }),
          };
          const gateway = await installMockGateway(page, {
            historyMessages: [],
            heldMethods: kind === "empty" ? ["sessions.files.list"] : [],
            methodResponses: {
              "artifacts.list": { artifacts: [] },
              "sessions.files.list": listing,
            },
          });
          await page.goto(suite.server.baseUrl + "chat");
          await openChatSidePanelType(page, "Files");
          const panel = page.locator(".chat-workspace-mobile");
          const scroll = panel.locator(".chat-workspace-mobile__scroll");
          const search = panel.getByRole("searchbox");
          if (kind === "empty") {
            await gateway.waitForRequest("sessions.files.list");
            await panel.locator("openclaw-panel-loading-skeleton").waitFor();
            await gateway.resolveDeferred("sessions.files.list");
          }
          await expect.poll(() => scroll.getAttribute("aria-busy")).toBe("false");
          if (kind === "no-match") {
            const beforeSearch = (await gateway.getRequests("sessions.files.list")).length;
            await gateway.deferNext("sessions.files.list");
            await gateway.setMethodResponse("sessions.files.list", {
              ...listing,
              browser: { path: "", search: "absent", entries: [] },
            });
            await search.fill("absent");
            await gateway.waitForRequest("sessions.files.list", { after: beforeSearch });
            await panel.locator("openclaw-panel-loading-skeleton").waitFor();
            await gateway.resolveDeferred("sessions.files.list");
            await panel.getByText("No files match your search.", { exact: true }).waitFor();
            await expect.poll(() => scroll.getAttribute("aria-busy")).toBe("false");
          }
          const accepted =
            kind === "populated"
              ? panel.getByRole("button", { name: "file-0.md", exact: true })
              : panel.getByText(
                  kind === "empty"
                    ? "No files match this filter."
                    : kind === "no-match"
                      ? "No files match your search."
                      : "Workspace files are unavailable.",
                  { exact: true },
                );
          await accepted.waitFor();
          const acceptedIdentity = await accepted.elementHandle();
          await search.focus();
          await search.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, el.value.length));
          if (kind === "populated") {
            await scroll.evaluate((el) => {
              el.scrollTop = 300;
            });
          }
          const beforeScroll = await scroll.evaluate((el) => el.scrollTop);
          const searchIdentity = await search.elementHandle();
          await captureFiles(page, "files-" + kind + "-settled", panel);
          const before = (await gateway.getRequests("sessions.files.list")).length;
          await gateway.deferNext("sessions.files.list");
          await gateway.emitChatFinal({
            runId: "files-refresh-" + kind,
            text: "Workspace refresh complete.",
          });
          await gateway.waitForRequest("sessions.files.list", { after: before });
          await expect.poll(() => scroll.getAttribute("aria-busy")).toBe("true");
          const skeletons = await panel.locator("openclaw-panel-loading-skeleton").count();
          const duringScroll = await scroll.evaluate((el) => el.scrollTop);
          const focusRetained = await searchIdentity!.evaluate(
            (el) => el === document.activeElement && el.isConnected,
          );
          const selection = await search.evaluate((el: HTMLInputElement) => [
            el.selectionStart,
            el.selectionEnd,
          ]);
          expect(await gateway.getRequests("sessions.files.list")).toHaveLength(before + 1);
          expect(skeletons).toBe(0);
          expect(await acceptedIdentity!.evaluate((el) => el.isConnected)).toBe(true);
          expect(await accepted.isVisible()).toBe(true);
          expect(selection).toEqual([0, kind === "no-match" ? 6 : 0]);
          if (kind === "populated") {
            expect(
              await panel.getByRole("button", { name: "file-0.md", exact: true }).count(),
            ).toBe(1);
            expect(duringScroll).toBe(beforeScroll);
          }
          expect(focusRetained).toBe(true);
          await captureFiles(page, "files-" + kind + "-pending", panel);
          await gateway.resolveDeferred("sessions.files.list");
          await expect.poll(() => scroll.getAttribute("aria-busy")).toBe("false");
        },
      );
    },
  );
});
