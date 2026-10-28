import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Document file links",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:main";
const section = "Additional human-agent development records";
const files = {
  "guides/faculty-guide.md":
    "# Faculty Guide\n\n[Development records](multiplayer-agentic-workflows.md#additional-human-agent-development-records)\n",
  "guides/multiplayer-agentic-workflows.md":
    "# Multiplayer agentic workflows\n\n[Local records](#additional-human-agent-development-records)\n\n[Level five](#level-five)\n\n[Level six](#level-six)\n\n[Updated records](#updated-records)\n\n" +
    "Background notes.\n\n".repeat(70) +
    "## " +
    section +
    "\n\nDevelopment records are here.\n\n" +
    "More notes.\n\n".repeat(30) +
    "##### Level five\n\n" +
    "More notes.\n\n".repeat(30) +
    "###### Level six\n\n" +
    "More notes.\n\n".repeat(30),
};
const fileResponse = (filePath: string, content: string) => ({
  root: "/workspace",
  sessionKey,
  file: {
    kind: "read",
    missing: false,
    name: path.basename(filePath),
    path: filePath,
    workspacePath: filePath,
    content,
    contentEncoding: "utf8",
    previewKind: "text",
    mimeType: "text/markdown",
  },
});

suite.define(() => {
  it("opens document-relative heading links without navigating or resolving another session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "demo-model", name: "Demo model", provider: "demo" }],
        agentModel: "demo/demo-model",
        historyMessages: [
          chatMessage("assistant", "[Faculty Guide](guides/faculty-guide.md)", { timestamp: 1 }),
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              ...Object.entries(files).map(([filePath, content]) => ({
                match: { path: "/workspace/" + filePath },
                response: fileResponse(filePath, content),
              })),
              {
                match: { path: "guides/faculty-guide.md" },
                response: fileResponse("guides/faculty-guide.md", files["guides/faculty-guide.md"]),
              },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat/main");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.getByRole("button", { name: "Faculty Guide", exact: true }).click();
      const reader = page.locator(".sidebar-file-view__markdown:visible");
      const link = reader.getByText("Development records", { exact: true });
      await link.waitFor();
      const chatUrl = page.url();
      const resolutions = (await gateway.getRequests("sessions.resolve")).length;
      await link.click();
      await expect
        .poll(
          async () =>
            page.url() !== chatUrl || (await gateway.getRequests("sessions.files.get")).length > 1,
        )
        .toBe(true);
      if (page.url() !== chatUrl) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("body"),
          [page.locator("body")],
          { animations: "disabled" },
        );
        await fs.writeFile(path.join(suite.artifactDir, "document-link-before.png"), frame.png);
      }
      expect(page.url()).toBe(chatUrl);
      const heading = reader.getByRole("heading", { name: section, exact: true });
      await heading.waitFor();
      const inReader = () =>
        heading.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const parent = element
            .closest(".sidebar-file-view__markdown-scroll")!
            .getBoundingClientRect();
          return bounds.top >= parent.top && bounds.bottom <= parent.bottom;
        });
      await expect.poll(inReader).toBe(true);
      const frame = await takeControlUiScreenshotFrame(page, reader, [heading], {
        animations: "disabled",
      });
      await fs.writeFile(path.join(suite.artifactDir, "document-link-after.png"), frame.png);
      const local = reader.getByText("Local records", { exact: true });
      await local.scrollIntoViewIfNeeded();
      await local.press("Enter");
      await expect.poll(inReader).toBe(true);
      for (const [name, level] of [
        ["Level five", 5],
        ["Level six", 6],
      ] as const) {
        await reader.getByRole("button", { name, exact: true }).click();
        const target = reader.getByRole("heading", { name, level, exact: true });
        await expect
          .poll(() =>
            target.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const scroll = element
                .closest(".sidebar-file-view__markdown-scroll")!
                .getBoundingClientRect();
              // Native scroll offsets round to CSS pixels; heading bounds can remain fractional.
              return (
                Math.round(bounds.top) >= Math.round(scroll.top) &&
                Math.round(bounds.bottom) <= Math.round(scroll.bottom)
              );
            }),
          )
          .toBe(true);
      }
      const retainedReader = await reader.elementHandle();
      const refreshedPath = "guides/multiplayer-agentic-workflows.md";
      await gateway.deferNext("sessions.files.get", { path: "/workspace/" + refreshedPath });
      await reader.getByRole("button", { name: "Updated records", exact: true }).click();
      await gateway.waitForRequest("sessions.files.get", { after: 5 });
      const refreshedHeading = reader.getByRole("heading", {
        name: "Updated records",
        exact: true,
      });
      expect(await refreshedHeading.count()).toBe(0);
      // Keep the old document rendered across frames before the response adds the target.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await retainedReader?.evaluate((element) => element.isConnected)).toBe(true);
      await gateway.resolveDeferred(
        "sessions.files.get",
        fileResponse(
          refreshedPath,
          files[refreshedPath] +
            "New background notes.\n\n".repeat(80) +
            "## Updated records\n\nNew records are here.\n\n" +
            "More notes.\n\n".repeat(30),
        ),
      );
      await refreshedHeading.waitFor();
      expect(
        await reader.evaluate((element, retained) => element === retained, retainedReader),
      ).toBe(true);
      await expect
        .poll(
          () =>
            refreshedHeading.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const viewport = element
                .closest(".sidebar-file-view__markdown-scroll")!
                .getBoundingClientRect();
              return (
                Math.round(bounds.top) >= Math.round(viewport.top) &&
                Math.round(bounds.bottom) <= Math.round(viewport.bottom)
              );
            }),
          { message: "The refreshed document must fulfill its pending heading navigation" },
        )
        .toBe(true);
      expect(page.url()).toBe(chatUrl);
      expect(
        (await gateway.getRequests("sessions.files.get")).map((request) => request.params),
      ).toMatchObject([
        { path: "guides/faculty-guide.md" },
        { path: "/workspace/guides/multiplayer-agentic-workflows.md" },
        { path: "/workspace/guides/multiplayer-agentic-workflows.md" },
        { path: "/workspace/guides/multiplayer-agentic-workflows.md" },
        { path: "/workspace/guides/multiplayer-agentic-workflows.md" },
        { path: "/workspace/guides/multiplayer-agentic-workflows.md" },
      ]);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(resolutions);
    });
  });
});
