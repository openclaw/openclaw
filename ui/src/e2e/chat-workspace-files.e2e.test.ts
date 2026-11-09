import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { openChatPanels, selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { chatDelta } from "./chat-flow-fixtures.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
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
  it("shows scratch expiry in Files and when opening its artifact", async () => {
    const evidence = createControlUiE2eArtifactDir("scratch-expiry");
    for (const expired of [false, true]) {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const message = expired
          ? "file expired (scratch cleaned after 24 h)"
          : "artifact download is unsupported";
        const title = expired ? `${message}: report.txt` : "report.txt";
        const gateway = await installMockGateway(page, {
          heldMethods: ["artifacts.download"],
          methodResponses: {
            "artifacts.list": {
              artifacts: [
                {
                  id: "scratch-report",
                  title,
                  type: "file",
                  download: { mode: "unsupported" },
                },
              ],
            },
            "sessions.files.list": { sessionKey: "main", root: "/workspace", files: [] },
          },
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Files");
        const row = page.locator(".workspace-desktop__row", { hasText: title });
        await row.waitFor();
        const capture = async (stage: string, content: typeof row) => {
          const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [content], {
            animations: "disabled",
            elements: [content],
          });
          await fs.writeFile(
            path.join(evidence, `${expired ? "after" : "before"}-${stage}.png`),
            frame.png,
          );
          await fs.writeFile(
            path.join(evidence, `${expired ? "after" : "before"}-${stage}-panel.png`),
            frame.elements[0]!.png,
          );
        };
        await capture("list", row);
        await row.click();
        await gateway.waitForRequest("artifacts.download");
        await gateway.rejectDeferred("artifacts.download", {
          code: "INVALID_REQUEST",
          message,
          details: { type: expired ? "artifact_file_expired" : "artifact_download_unsupported" },
        });
        const notice = page.locator(".empty-state__description", { hasText: message });
        await notice.waitFor();
        await capture("open", notice);
        expect(await gateway.getRequests("artifacts.download")).toHaveLength(1);
      });
    }
  });

  it("keeps transcript attachment icons compact beside project files", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "attachment",
                attachment: {
                  kind: "document",
                  label: "Cafe\u0301-ΕΛΕΓΧΟΣ-checklist.txt",
                  mimeType: "text/plain",
                  url: "https://example.com/release-checklist.txt",
                },
              },
              {
                type: "image",
                url: "https://example.com/layout.png",
                alt: "Cafe\u0301-ΕΛΕΓΧΟΣ-layout.png",
              },
            ],
          },
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          "sessions.files.list": {
            sessionKey: "main",
            root: "/workspace",
            files: [],
            browser: {
              path: "",
              entries: [{ kind: "file", name: "README.md", path: "README.md" }],
            },
          },
        },
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      for (const presentation of ["desktop", "narrow", "mobile"]) {
        const mobile = presentation === "mobile";
        if (presentation === "narrow") {
          await page.getByRole("separator", { name: "Resize side panel" }).press("End");
        } else if (mobile) {
          await page.setViewportSize({ width: 390, height: 900 });
          await openChatPanels(page, "mobile");
        }
        const selector = mobile
          ? '.chat-workspace-mobile__group[role="list"] .chat-workspace-mobile__row'
          : ".workspace-desktop__session-scroll .workspace-desktop__row";
        const attachments = page.locator(selector);
        await expect.poll(() => attachments.count()).toBe(2);
        await attachments.first().waitFor();
        await waitForLayoutSettled(page, selector);
        for (const row of await attachments.all()) {
          const bounds = await row.evaluate((element) => {
            const rowRect = element.getBoundingClientRect();
            const icons = [...element.querySelectorAll("svg")].map((icon) => {
              const rect = icon.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            });
            const name = element.querySelector('[class$="__identity"]')!.getBoundingClientRect();
            return {
              rowHeight: rowRect.height,
              rowWidth: rowRect.width,
              icons,
              nameWidth: name.width,
              contained: name.left >= rowRect.left && name.right <= rowRect.right,
            };
          });
          for (const icon of bounds.icons) {
            expect(icon.width).toBeGreaterThan(0);
            expect(Math.max(icon.width, icon.height)).toBeLessThanOrEqual(20);
          }
          expect(bounds.icons).toHaveLength(mobile ? 2 : 1);
          expect(bounds.rowHeight).toBeLessThanOrEqual(mobile ? 48 : 32);
          expect(bounds.nameWidth).toBeGreaterThan(80);
          expect(bounds.contained).toBe(true);
          if (presentation === "narrow") {
            expect(bounds.rowWidth).toBeLessThan(270);
          }
        }
        const projectFile = page.getByRole("button", { name: "README.md", exact: true });
        await projectFile.waitFor();
        expect((await projectFile.boundingBox())!.height).toBeLessThanOrEqual(mobile ? 48 : 32);
      }
      await page.getByRole("searchbox", { name: "Search files", exact: true }).fill("CAFÉ");
      await page.getByText("Cafe\u0301-ΕΛΕΓΧΟΣ-checklist", { exact: true }).waitFor();
      for (const query of ["Σ", "σ", "ς"]) {
        await page.getByRole("searchbox", { name: "Search files", exact: true }).fill(query);
        await page.getByText("Cafe\u0301-ΕΛΕΓΧΟΣ-checklist", { exact: true }).waitFor();
      }
    });
  });

  it("keeps chat and file navigation usable when returning to a file's folder", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
        sessions: [
          createControlUiSessionRow("agent:main:main", "Delivery notes", Date.now(), {
            visibility: "shared",
            sharingRole: "owner",
          }),
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          "sessions.files.list": {
            sessionKey: "main",
            root: "/workspace",
            files: [],
            browser: {
              path: "",
              entries: [{ kind: "file", name: "notes.md", path: "notes.md", size: 17 }],
            },
          },
          "sessions.files.get": {
            sessionKey: "main",
            root: "/workspace",
            file: {
              name: "notes.md",
              path: "notes.md",
              workspacePath: "notes.md",
              content: "# Delivery notes\n",
              previewKind: "text",
              contentEncoding: "utf8",
            },
          },
          "sessions.files.download": {
            filename: "notes.md",
            mimeType: "text/markdown",
            url: "/api/artifacts/download/navigation/notes",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        },
      });
      await page.route("**/api/artifacts/download/navigation/notes", (route) =>
        route.fulfill({ body: "# Delivery notes\n", contentType: "text/markdown" }),
      );
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
      await composer.fill("Please review the delivery notes before publishing.");
      await openChatSidePanelType(page, "Files");
      const file = page.locator(".workspace-desktop").getByRole("button", {
        name: "notes.md",
        exact: true,
      });
      await file.click();
      const heading = page.getByRole("heading", { name: "Delivery notes", exact: true });
      await heading.waitFor();
      await gateway.deferNext("sessions.files.download");
      await page.getByRole("button", { name: "More file actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Attach to session", exact: true }).click();
      await gateway.waitForRequest("sessions.files.download");
      await page.setViewportSize({ width: 1300, height: 900 });
      await waitForLayoutSettled(page, "openclaw-chat-detail-panel");
      await gateway.resolveDeferred("sessions.files.download");
      await page.getByRole("button", { name: "Remove notes.md", exact: true }).waitFor();
      expect(await composer.inputValue()).toBe(
        "Please review the delivery notes before publishing.",
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const sent = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(sent.params).idempotencyKey, "run ID");
      await gateway.emitGatewayEvent(
        "chat",
        chatDelta(runId, "Reviewing the delivery notes.", "agent:main:main", { seq: 1 }),
      );
      await page
        .locator(".chat-bubble.streaming", { hasText: "Reviewing the delivery notes." })
        .waitFor();
      await composer.fill("Keep the examples ready for review.");
      expect(errors).toEqual([]);
      await page.getByRole("button", { name: "Root", exact: true }).click();
      await file.waitFor({ state: "visible" });
      await heading.waitFor({ state: "hidden" });
      await file.click();
      await heading.waitFor();
      await gateway.emitChatFinal({ runId, text: "The delivery notes are ready." });
      await page
        .locator(".chat-group.assistant .chat-text", { hasText: "The delivery notes are ready." })
        .waitFor();
      await page.getByRole("button", { name: "Stop", exact: true }).waitFor({
        state: "hidden",
      });
      expect(await composer.inputValue()).toBe("Keep the examples ready for review.");
      expect(errors).toEqual([]);
    });
  });

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
      await openChatPanels(page, "mobile");
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

  it("tiles session files in the chosen order and remembers the display", async () => {
    const evidence = createControlUiE2eArtifactDir("session-files-grid");
    const swatch = (fill: string) =>
      `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><rect width='100%' height='100%' fill='${fill}'/><circle cx='200' cy='150' r='90' fill='white' fill-opacity='0.35'/></svg>`,
      )}`;
    const document = (label: string, mimeType: string) => ({
      type: "attachment",
      attachment: {
        kind: "document",
        label,
        mimeType,
        url: `https://example.com/${label}`,
      },
    });
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            timestamp: 1_700_000_100_000,
            content: [
              { type: "image", url: swatch("#8e2b2b") },
              { type: "image", url: swatch("#1f1f1f") },
              document("Back_Isometric_on_Black.jpg", "image/jpeg"),
              document("ClawCon_Shenzhen_Isometric_Concept_11.pdf", "application/pdf"),
              document("ClawCon_Shenzhen_Isometric_Artwork_11.zip", "application/zip"),
            ],
          },
          {
            role: "assistant",
            timestamp: 1_700_000_300_000,
            content: [
              { type: "image", url: swatch("#2b5f8e"), alt: "Silicon_Front_Detail.png" },
              { type: "image", url: swatch("#e8e2d6") },
              document("ClawCon_Shenzhen_Silicon_Concept_12.pdf", "application/pdf"),
            ],
          },
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          "sessions.files.list": {
            sessionKey: "main",
            root: "/workspace",
            files: [
              {
                path: "/tmp/outputs/notes.md",
                name: "notes.md",
                kind: "modified",
                missing: false,
                workspacePath: "/tmp/outputs/notes.md",
                updatedAtMs: 1_700_000_200_000,
              },
            ],
          },
        },
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const sessionList = page.getByRole("list", { name: "Session files" });
      const rows = sessionList.locator("[role=listitem] > button");
      await expect.poll(() => rows.count()).toBe(9);
      const labels = () => rows.evaluateAll((items) => items.map((item) => item.ariaLabel));
      expect(await labels()).toEqual([
        "/tmp/outputs/notes.md",
        "Image",
        "Image",
        "Back_Isometric_on_Black.jpg",
        "ClawCon_Shenzhen_Isometric_Concept_11.pdf",
        "ClawCon_Shenzhen_Isometric_Artwork_11.zip",
        "Silicon_Front_Detail.png",
        "Image",
        "ClawCon_Shenzhen_Silicon_Concept_12.pdf",
      ]);
      const panel = page.locator('[data-panel-slot="workspace"]:not([hidden])');
      const capture = async (stage: string) => {
        await page.mouse.move(0, 0);
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [panel], {
          animations: "disabled",
          elements: [panel],
        });
        await fs.writeFile(path.join(evidence, `${stage}.png`), frame.png);
        await fs.writeFile(path.join(evidence, `${stage}-panel.png`), frame.elements[0]!.png);
      };
      await capture("list");

      const display = page.getByRole("button", { name: "Session files view and order" });
      await display.click();
      await page.getByRole("menuitemradio", { name: "Grid" }).click();
      const tiles = sessionList.locator(".workspace-desktop__tile");
      await expect.poll(() => tiles.count()).toBe(9);
      // Untitled transcript images show their pixels without a generic caption; files keep names.
      const untitled = tiles.nth(1);
      await untitled.locator("img.workspace-desktop__tile-image").waitFor();
      expect(await untitled.locator(".workspace-desktop__tile-name").count()).toBe(0);
      await expect
        .poll(() =>
          untitled.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth > 0),
        )
        .toBe(true);
      expect(await tiles.nth(3).locator(".workspace-desktop__tile-name").textContent()).toBe(
        "Back_Isometric_on_Black.jpg",
      );
      const tileBoxes = await Promise.all(
        [0, 1, 2].map(async (index) => (await tiles.nth(index).boundingBox())!),
      );
      expect(tileBoxes[0]!.y).toBe(tileBoxes[1]!.y);
      expect(tileBoxes[1]!.x).toBeGreaterThan(tileBoxes[0]!.x);
      await capture("grid");

      await display.click();
      await page.getByRole("menuitemradio", { name: "Type" }).click();
      await expect
        .poll(labels)
        .toEqual([
          "ClawCon_Shenzhen_Isometric_Artwork_11.zip",
          "Back_Isometric_on_Black.jpg",
          "Image",
          "Image",
          "Image",
          "Silicon_Front_Detail.png",
          "/tmp/outputs/notes.md",
          "ClawCon_Shenzhen_Isometric_Concept_11.pdf",
          "ClawCon_Shenzhen_Silicon_Concept_12.pdf",
        ]);
      await capture("grid-by-type");

      // Date interleaves the session file (modified between the two messages) by real time.
      await display.click();
      await page.getByRole("menuitemradio", { name: "Date" }).click();
      await expect
        .poll(labels)
        .toEqual([
          "Silicon_Front_Detail.png",
          "Image",
          "ClawCon_Shenzhen_Silicon_Concept_12.pdf",
          "/tmp/outputs/notes.md",
          "Image",
          "Image",
          "Back_Isometric_on_Black.jpg",
          "ClawCon_Shenzhen_Isometric_Concept_11.pdf",
          "ClawCon_Shenzhen_Isometric_Artwork_11.zip",
        ]);

      // The display is a browser preference: a reload keeps grid and date order.
      await page.reload();
      await openChatSidePanelType(page, "Files");
      await expect.poll(() => sessionList.locator(".workspace-desktop__tile").count()).toBe(9);
      expect((await labels())[0]).toBe("Silicon_Front_Detail.png");
    });
  });
});
