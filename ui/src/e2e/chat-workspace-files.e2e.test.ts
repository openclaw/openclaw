import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const previewArtifact = {
  id: "artifact-1",
  title: "preview.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  type: "image",
  download: { mode: "bytes" },
};

suite.define(() => {
  it("retries a failed post-run listing without hiding a rejected retry", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.files.list": {
            sessionKey: "main",
            root: "/workspace",
            files: [{ kind: "modified", name: "checklist.md", path: "checklist.md", size: 42 }],
          },
          "artifacts.list": { artifacts: [] },
        },
      });
      const listRequests = () => gateway.getRequests("sessions.files.list");
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".workspace-desktop");
      await rail.getByText("checklist.md", { exact: true }).waitFor();
      await gateway.deferNext("sessions.files.list");
      await gateway.emitChatFinal({ runId: "files-revision", text: "Checklist updated." });
      await expect.poll(listRequests).toHaveLength(2);
      await gateway.rejectDeferred("sessions.files.list", {
        code: "UNAVAILABLE",
        message: "Session workspace changed during file read",
      });
      const error = rail.getByText("Session workspace changed during file read", { exact: true });
      await error.waitFor();
      await selectChatLayoutAction(page, "Collapse session workspace");
      await rail.waitFor({ state: "hidden" });
      await openChatSidePanelType(page, "Files");
      await error.waitFor();
      expect(await listRequests()).toHaveLength(2);
      const retry = rail.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      await gateway.deferNext("sessions.files.list");
      await retry.click();
      await expect.poll(listRequests).toHaveLength(3);
      await gateway.rejectDeferred("sessions.files.list", {
        code: "FORBIDDEN",
        message: "Session files are unavailable",
      });
      const denied = rail.getByRole("alert");
      await expect.poll(() => denied.textContent()).toBe("Session files are unavailable");
      expect(await rail.locator(".workspace-desktop__row").count()).toBe(0);
      await retry.click();
      await rail.getByText("checklist.md", { exact: true }).waitFor();
      const requests = await listRequests();
      expect(requests).toHaveLength(4);
      expect(requests[2]?.params).toEqual(requests[1]?.params);
      expect(requests[3]?.params).toEqual(requests[1]?.params);
      expect(await denied.count()).toBe(0);
      expect(await retry.count()).toBe(0);
    });
  });

  it("keeps Files lazy, scrolls below its toolbar, and reveals reviewed files", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          "artifacts.list": { artifacts: [{ ...previewArtifact, sizeBytes: 128 }] },
          "sessions.files.list": {
            browser: {
              entries: [
                { kind: "directory", name: "src", path: "src", sessionKind: "modified" },
                { kind: "file", name: "package.json", path: "package.json", size: 4096 },
                ...Array.from({ length: 60 }, (_, index) => ({
                  kind: "file",
                  name: "file-" + index + ".ts",
                  path: "file-" + index + ".ts",
                })),
              ],
              path: "",
            },
            files: [{ kind: "modified", name: "AGENTS.md", path: "/workspace/AGENTS.md" }],
            root: "/workspace",
            sessionKey: "main",
          },
          "sessions.diff": {
            additions: 1,
            branch: "main",
            deletions: 0,
            files: [{ additions: 1, deletions: 0, path: "AFTER_RUN.md", status: "modified" }],
            root: "/workspace",
            sessionKey: "main",
          },
        },
      });

      const waitForFile = (name: string) =>
        page.locator(".workspace-desktop__row", { hasText: name }).waitFor({ timeout: 10_000 });
      const setModifiedFile = (name: string) =>
        gateway.setMethodResponse("sessions.files.list", {
          files: [{ kind: "modified", name, path: `/workspace/${name}` }],
        });
      const listRequests = () => gateway.getRequests("sessions.files.list");
      await page.goto(`${suite.server.baseUrl}chat`);
      expect(await listRequests()).toHaveLength(0);
      expect(await page.locator(".workspace-desktop:visible").count()).toBe(0);

      await openChatSidePanelType(page, "Files");
      await waitForFile("AGENTS.md");
      await waitForFile("preview.png");
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await waitForFile("package.json");
      expect(await listRequests()).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      expect(
        await page.locator(".workspace-desktop").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        }),
      ).toBe(0);

      await page.setViewportSize({ width: 1280, height: 720 });
      const rail = page.locator(".workspace-desktop");
      const scroll = rail.locator(".workspace-desktop__project-scroll");
      const toolbar = rail.locator(".workspace-desktop__toolbar");
      const before = await toolbar.boundingBox();
      await expect
        .poll(() =>
          scroll.evaluate((element) => ({
            overflows: element.scrollHeight > element.clientHeight,
            overflowY: getComputedStyle(element).overflowY,
          })),
        )
        .toEqual({ overflows: true, overflowY: "auto" });
      await scroll.hover();
      await page.mouse.wheel(0, 600);
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const after = await toolbar.boundingBox();
      expect(before).not.toBeNull();
      expect(after).toEqual(before);
      await page.setViewportSize({ width: 1280, height: 900 });

      await setModifiedFile("AFTER_RUN.md");
      await openChatSidePanelType(page, "Review");
      await page.locator('[data-panel-slot="detail"]:not([hidden])').waitFor();
      await page.getByRole("button", { name: "Actions for AFTER_RUN.md" }).click();
      await page.locator('openclaw-session-diff-menu button[value="reveal-file"]').click();
      await expect.poll(listRequests).toHaveLength(2);
      await waitForFile("AFTER_RUN.md");
      await page.setViewportSize({ height: 900, width: 640 });
      const workspaceRail = page.locator(".chat-workspace-mobile");
      await workspaceRail.waitFor();
      await expect
        .poll(async () => {
          const box = await workspaceRail.boundingBox();
          return Boolean(box && box.width > 0 && box.height > 0);
        })
        .toBe(true);
      expect(await page.locator(".chat-workspace-rail__dock").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__grip").count()).toBe(0);
    });
  });
});
