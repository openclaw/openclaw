import { expect, it } from "vitest";
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
      const rail = page.locator(".chat-workspace-rail");
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
      await page.getByRole("button", { name: "Close Files" }).click();
      await rail.waitFor({ state: "detached" });
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
      expect(await rail.locator(".chat-workspace-rail__file-name").count()).toBe(0);
      expect(await listRequests()).toHaveLength(3);
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

  it("starts the workspace files panel collapsed and toggles it open", async () => {
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
              ],
              path: "",
            },
            files: [
              {
                kind: "modified",
                name: "AGENTS.md",
                path: "/workspace/AGENTS.md",
              },
            ],
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
        page
          .locator(".chat-workspace-rail__file-name", { hasText: name })
          .waitFor({ timeout: 10_000 });
      const setModifiedFile = (name: string) =>
        gateway.setMethodResponse("sessions.files.list", {
          files: [{ kind: "modified", name, path: `/workspace/${name}` }],
        });
      const listRequests = () => gateway.getRequests("sessions.files.list");
      await page.goto(`${suite.server.baseUrl}chat`);
      expect(await listRequests()).toHaveLength(0);
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);

      await openChatSidePanelType(page, "Files");
      await waitForFile("AGENTS.md");
      await page.locator(".chat-workspace-rail__group-summary", { hasText: "Artifacts" }).click();
      await waitForFile("preview.png");
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await waitForFile("package.json");
      expect(await listRequests()).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      expect(
        await page.locator(".chat-workspace-rail").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        }),
      ).toBe(0);

      await page.getByRole("button", { name: "Close Files" }).click();
      await page.locator(".chat-workspace-rail").waitFor({ state: "detached" });
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);
      await setModifiedFile("AFTER_RUN.md");
      await gateway.emitChatFinal({
        runId: "workspace-closed-run",
        text: "Workspace stayed closed.",
      });
      await expect.poll(() => page.getByText("Workspace stayed closed.").count()).toBe(1);
      expect(await listRequests()).toHaveLength(1);

      await openChatSidePanelType(page, "Files");
      await expect.poll(listRequests).toHaveLength(2);
      await waitForFile("AFTER_RUN.md");
      expect(await listRequests()).toHaveLength(2);

      await openChatSidePanelType(page, "Review");
      await page.locator('[data-panel-slot="detail"]:not([hidden])').waitFor();
      await page.getByRole("button", { name: "Actions for AFTER_RUN.md" }).click();
      await page.locator('openclaw-session-diff-menu button[value="reveal-file"]').click();
      await expect.poll(listRequests).toHaveLength(3);
      await waitForFile("AFTER_RUN.md");
      await page.locator(".tabstrip-tab").filter({ hasText: "Review" }).click();
      await setModifiedFile("AFTER_REVIEW.md");
      await gateway.emitChatFinal({
        runId: "workspace-inactive-run",
        text: "Workspace stayed inactive.",
      });
      await page.getByText("Workspace stayed inactive.").first().waitFor();
      expect(await listRequests()).toHaveLength(3);

      await page.locator(".tabstrip-tab").filter({ hasText: "Files" }).click();
      await expect.poll(listRequests).toHaveLength(4);
      await waitForFile("AFTER_REVIEW.md");

      await page.setViewportSize({ height: 900, width: 640 });
      await page.locator(".sidebar-region--narrow").waitFor();
      const workspaceRail = page.locator(".chat-workspace-rail");
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

  it("scrolls long file groups beneath the search toolbar and filters session files", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
      },
      async ({ page }) => {
        const browserEntries = Array.from({ length: 60 }, (_, index) => ({
          kind: "file" as const,
          name: `file-${String(index + 1).padStart(2, "0")}.ts`,
          path: `src/file-${String(index + 1).padStart(2, "0")}.ts`,
        }));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.files.list": {
              browser: { entries: browserEntries, path: "" },
              files: [
                ...Array.from({ length: 2 }, (_, index) => ({
                  kind: "modified",
                  name: `changed-${index + 1}.ts`,
                  path: `src/changed-${index + 1}.ts`,
                })),
                ...["read-file-1.ts", "read-file-2.ts", "notes.md"].map((name) => ({
                  kind: "read",
                  name,
                  path: `src/${name}`,
                })),
              ],
              root: "/workspace",
              sessionKey: "main",
            },
            "artifacts.list": { artifacts: [previewArtifact] },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Files");
        await page.locator(".chat-workspace-rail__file-name", { hasText: "file-60.ts" }).waitFor({
          timeout: 10_000,
        });
        expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

        const rail = page.locator(".chat-workspace-rail");
        const scroll = rail.locator(".chat-workspace-rail__scroll");
        const browserGroup = rail.locator(".chat-workspace-rail__group", {
          hasText: "Project files",
        });
        await expect
          .poll(() =>
            scroll.evaluate((element) => ({
              overflows: element.scrollHeight > element.clientHeight,
              overflowY: getComputedStyle(element).overflowY,
            })),
          )
          .toEqual({ overflows: true, overflowY: "auto" });
        expect(await browserGroup.evaluate((element) => getComputedStyle(element).overflowY)).toBe(
          "visible",
        );
        expect(
          await rail
            .locator(".chat-workspace-rail__group")
            .evaluateAll((groups) =>
              groups.some((group) =>
                ["auto", "scroll"].includes(getComputedStyle(group).overflowY),
              ),
            ),
        ).toBe(false);
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const railBox = await rail.boundingBox();
        const search = rail.locator('input[type="search"]');
        const searchBox = await search.boundingBox();
        expect(railBox).not.toBeNull();
        expect(searchBox).not.toBeNull();
        expect(searchBox!.y).toBeGreaterThanOrEqual(railBox!.y);
        expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(railBox!.y + railBox!.height);

        const readFilter = rail.getByRole("button", { name: "3 read", exact: true });
        await readFilter.click();
        const groups = rail.locator(".chat-workspace-rail__group");
        await expect.poll(() => groups.count()).toBe(1);
        expect(await groups.locator("summary").textContent()).toContain("Read");
        expect(await groups.locator(".chat-workspace-rail__file:visible").count()).toBe(3);
        expect(await readFilter.getAttribute("aria-pressed")).toBe("true");

        await search.fill("read-file");
        await expect
          .poll(() => groups.locator(".chat-workspace-rail__file-name:visible").allTextContents())
          .toEqual(["read-file-1.ts", "read-file-2.ts"]);
        expect(
          await groups
            .locator(".chat-workspace-rail__file-open:visible")
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
        ).toEqual(["src/read-file-1.ts", "src/read-file-2.ts"]);
        expect(await groups.count()).toBe(1);
      },
    );
  });
});
