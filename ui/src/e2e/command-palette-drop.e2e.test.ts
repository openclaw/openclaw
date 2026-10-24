import { devices, type Locator } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  expectForegroundUnchanged,
  openFromForeground,
  scenario,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette file drops" });
const profile = (id: string, displayName: string) => ({
  id,
  displayName,
  emails: [],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 1,
});

async function attach(target: Locator, kind: "paste" | "drop" | "drag") {
  return target.evaluate((element, eventKind) => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#203549";
    context.fillRect(0, 0, 160, 100);
    context.fillStyle = "#9ec7d8";
    context.fillRect(12, 14, 136, 18);
    context.fillStyle = "#ff7164";
    context.fillRect(12, 44, 62, 40);
    context.fillStyle = "#6d9bac";
    context.fillRect(86, 44, 62, 40);
    const content = canvas.toDataURL("image/png").split(",")[1]!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], "launcher.png", {
        type: "image/png",
      }),
    );
    if (eventKind === "paste") {
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    } else {
      transfer.items.add(
        new File(["Synthetic design brief"], "design-brief.pdf", { type: "application/pdf" }),
      );
      for (const type of eventKind === "drag"
        ? ["dragenter", "dragover"]
        : ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    }
    return content;
  }, kind);
}

suite.define(() => {
  it("retains a dropped draft across reconnect and retires it for another account", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        scenario({
          "users.self": {
            profile: profile("alice", "Alice"),
          },
        }),
      );
      const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
      await attach(palette.locator(".cmd-palette"), "drop");
      await expect.poll(() => palette.locator(".chat-attachment-thumb").count()).toBe(2);
      await input.fill("Retain this draft for Alice");
      await input.press("Escape");
      await input.waitFor({ state: "hidden" });
      await reconnectMockGateway(page, gateway);
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      expect(await input.inputValue()).toBe("Retain this draft for Alice");
      expect(await palette.locator(".chat-attachment-thumb").count()).toBe(2);
      await input.press("Escape");
      await input.waitFor({ state: "hidden" });
      await gateway.setMethodResponse("users.self", {
        profile: profile("bob", "Bob"),
      });
      const beforeAccountChange = await gateway.deferNext("users.self");
      await reconnectMockGateway(page, gateway);
      await gateway.waitForRequest("users.self", { after: beforeAccountChange });
      await gateway.resolveDeferred("users.self");
      // Transport readiness precedes profile adoption, which retires the old account's launcher.
      await expect
        .poll(() =>
          evaluateControlUiContext(page, (context) => context.gateway.snapshot.selfUser?.id),
        )
        .toBe("bob");
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      await expect.poll(() => input.inputValue()).toBe("");
      expect(await palette.locator(".chat-attachment-thumb").count()).toBe(0);
      expect(await gateway.getRequests("sessions.create")).toEqual([]);
    });
  });

  it.each([
    { width: 1280, theme: "dark" },
    { width: 390, theme: "light" },
  ] as const)(
    "drops files into a dedicated new-session draft at $width px ($theme)",
    async ({ width, theme }) => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          ...(width === 390 ? devices["Pixel 7"] : {}),
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(
            page,
            scenario({
              "sessions.create": { key: "agent:main:dashboard:dropped-files", runStarted: true },
            }),
          );
          const { palette, input, composer, url } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
            document.documentElement.dataset.themeMode = mode;
          }, theme);
          const surface = palette.locator(".cmd-palette");
          await attach(input, "paste");
          const images = palette.locator(".chat-attachment-thumb img");
          await expect.poll(() => images.count()).toBe(1);
          await palette.getByRole("button", { name: "Remove launcher.png", exact: true }).click();
          await expect.poll(() => images.count()).toBe(0);
          await attach(surface, "drag");
          expect(await surface.getAttribute("data-attachment-drop-active")).not.toBeNull();
          const imageContent = await attach(surface, "drop");
          await expect.poll(() => palette.locator(".chat-attachment-thumb").count()).toBe(2);
          await expect
            .poll(() => palette.locator(".chat-attachment-file__name").textContent())
            .toBe("design-brief.pdf");
          const start = palette.getByRole("button", {
            name: "Start new session in background",
            exact: true,
          });
          await expect.poll(() => start.isEnabled()).toBe(true);
          expect(
            await palette.locator(".cmd-palette__search").getAttribute("inert"),
          ).not.toBeNull();
          expect(await input.getAttribute("aria-controls")).toBeNull();
          await input.fill("Review these");
          await input.press("Enter");
          expect(await input.inputValue()).toBe(width === 390 ? "Review these\n" : "Review these");
          if (width === 390) {
            await input.pressSequentially("Keep the summary short");
          }
          const prompt = width === 390 ? "Review these\nKeep the summary short" : "Review these";
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          if (width === 390) {
            expect(await start.locator("kbd").count()).toBe(0);
            const footer = surface.locator(":scope > .cmd-palette__footer");
            expect(await footer.locator("kbd").count()).toBe(1);
            expect(await footer.locator("kbd").textContent()).toMatch(/^(Enter|⏎)$/);
          }
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          expect(await input.inputValue()).toBe(prompt);
          expect(await images.count()).toBe(1);
          expect(await palette.locator(".chat-attachment-thumb").count()).toBe(2);
          if (width === 390) {
            await start.click();
          } else {
            await input.press("ControlOrMeta+Enter");
          }
          const created = await gateway.waitForRequest("sessions.create");
          expect(created.params).toMatchObject({
            message: prompt,
            attachments: [
              {
                type: "image",
                fileName: "launcher.png",
                mimeType: "image/png",
                content: imageContent,
              },
              {
                type: "file",
                fileName: "design-brief.pdf",
                mimeType: "application/pdf",
                content: Buffer.from("Synthetic design brief").toString("base64"),
              },
            ],
          });
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
        },
      );
    },
  );
});
