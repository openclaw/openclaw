import type { FileChooser, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowser,
  attachmentImage,
  attachmentOption,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Platform attachment menu",
  browserLaunchOptions: { args: ["--use-fake-device-for-media-stream"] },
});

type ChatFixture = {
  route: string;
  browser?: string;
  preview?: "unsupported" | "permission-denied";
  geometry?: boolean;
  cameraPermission?: boolean;
};

function withChat(
  options: ChatFixture,
  run: (page: Page, choosers: () => number) => Promise<void>,
) {
  const identity = options.browser ? attachmentBrowser(options.browser) : undefined;
  return suite.withPage(
    {
      viewport: options.cameraPermission
        ? { width: 1280, height: 900 }
        : { width: 390, height: 844 },
      ...(identity ? { userAgent: identity.userAgent, hasTouch: identity.touch > 0 } : {}),
      ...(options.cameraPermission ? { permissions: ["camera"] } : {}),
    },
    async ({ page }) => {
      if (identity) {
        await installAttachmentBrowserIdentity(page, identity);
      }
      if (options.geometry) {
        await capturePickerGeometry(page);
      }
      if (options.cameraPermission) {
        await page.addInitScript(() => {
          const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = (constraints) => {
            document.documentElement.dataset.cameraActivation = String(
              navigator.userActivation.isActive,
            );
            return getUserMedia(constraints);
          };
        });
      }
      if (options.preview) {
        await page.addInitScript((kind) => {
          if (kind === "permission-denied") {
            navigator.mediaDevices.getUserMedia = async () => {
              document.documentElement.dataset.cameraRequested = "true";
              throw new DOMException("Preview permission denied", "NotAllowedError");
            };
          } else {
            Object.defineProperty(navigator, "mediaDevices", {
              configurable: true,
              value: undefined,
            });
          }
        }, options.preview);
      }
      await installMockGateway(page);
      let chooserCount = 0;
      page.on("filechooser", () => {
        chooserCount += 1;
      });
      await page.goto(suite.server.baseUrl + options.route);
      await run(page, () => chooserCount);
    },
  );
}

async function choose(page: Page, kind: string) {
  await page.getByRole("button", { name: "Add attachment", exact: true }).press("Enter");
  const item = attachmentOption(page, kind);
  await item.waitFor({ state: "visible" });
  const pending = page.waitForEvent("filechooser");
  await item.press("Enter");
  const chooser = await pending;
  const input = chooser.element();
  expect(chooser.isMultiple()).toBe(kind !== "camera");
  expect(await input.getAttribute("capture")).toBe(kind === "camera" ? "environment" : null);
  expect(await input.getAttribute("accept")).toBe(
    kind === "file" ? null : kind === "media" ? "image/*,video/*" : "image/*",
  );
  return chooser;
}

function cameraButton(page: Page, name: string) {
  return page.locator("openclaw-chat-camera-capture").getByRole("button", { name, exact: true });
}

async function capturePickerGeometry(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== "file") {
          return;
        }
        const trigger = input
          .closest(".agent-chat__composer-shell")!
          .querySelector(".agent-chat__input-btn--attach")!;
        input.dataset.pickerGeometry = JSON.stringify({
          input: input.getBoundingClientRect().toJSON(),
          trigger: trigger.getBoundingClientRect().toJSON(),
        });
      },
      true,
    );
  });
}

async function expectPickerAtPlusButton(chooser: FileChooser) {
  const geometry = await chooser.element().evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected the file chooser to belong to an HTML input");
    }
    // SAFETY: The capture listener above writes both DOMRect snapshots before click activation.
    return JSON.parse(input.dataset.pickerGeometry!) as {
      input: { left: number; top: number; width: number; height: number };
      trigger: { left: number; top: number; width: number; height: number };
    };
  });
  expect(geometry.trigger.width).toBeGreaterThan(0);
  expect(geometry.trigger.height).toBeGreaterThan(0);
  for (const axis of ["left", "top", "width", "height"] as const) {
    expect(geometry.input[axis]).toBeCloseTo(geometry.trigger[axis], 1);
  }
}

suite.define(() => {
  it.each(
    ["chat", "new"].flatMap((route) =>
      ["iPhone Safari", "iOS Chrome"].map((name) => ({ route, name })),
    ),
  )("anchors $name upload and fallback pickers in $route", async ({ route, name }) => {
    const cameraFallback = name === "iOS Chrome";
    await withChat(
      { route, browser: name, geometry: true, preview: cameraFallback ? "unsupported" : undefined },
      async (page) => {
        const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
        const widths: [number, number][] = [
          [390, 844],
          [320, 568],
        ];
        if (cameraFallback) {
          widths.push([932, 430]);
        }
        for (const [width, height] of widths) {
          await page.setViewportSize({ width, height });
          const mediaChooser = await choose(page, "media");
          await expectPickerAtPlusButton(mediaChooser);
          await mediaChooser.setFiles([]);
          await trigger.click();
          const pending = page.waitForEvent("filechooser");
          if (cameraFallback) {
            await page.getByRole("menuitem", { name: "Take photo", exact: true }).click();
            await cameraButton(page, width === 932 ? "Use device camera" : "Upload photo").click();
          } else {
            await attachmentOption(page, "file").click();
          }
          const chooser = await pending;
          if (!cameraFallback) {
            expect(await chooser.element().getAttribute("tabindex")).toBe("-1");
          }
          await expectPickerAtPlusButton(chooser);
          await chooser.setFiles([]);
        }
      },
    );
  });

  it.each([
    { route: "new", availability: "unsupported" },
    { route: "chat", availability: "permission-denied" },
  ] as const)(
    "offers explicit native capture in $route when preview is $availability",
    ({ route, availability }) =>
      withChat({ route, preview: availability }, async (page, chooserCount) => {
        await page.getByRole("button", { name: "Add attachment", exact: true }).click();
        await page.getByRole("menuitem", { name: "Take photo", exact: true }).click();
        const nativeCapture = cameraButton(page, "Use device camera");
        await nativeCapture.waitFor();
        expect(chooserCount()).toBe(0);
        const pending = page.waitForEvent("filechooser");
        await nativeCapture.click();
        const chooser = await pending;
        expect(await chooser.element().getAttribute("capture")).toBe("environment");
        expect(await chooser.element().getAttribute("accept")).toBe("image/*");
        expect(chooser.isMultiple()).toBe(false);
        await chooser.setFiles([]);
        expect(chooserCount()).toBe(1);
        expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
      }),
  );

  it.each(["chat", "new"])("captures a camera photo without opening a picker in %s", (route) =>
    withChat({ route, cameraPermission: true }, async (page, fileChoosers) => {
      await page.getByRole("button", { name: "Add attachment", exact: true }).click();
      await page.getByRole("menuitem", { name: "Take photo", exact: true }).click();
      expect(await page.locator("html").getAttribute("data-camera-activation")).toBe("true");
      const capture = cameraButton(page, "Capture");
      await expect.poll(() => capture.isEnabled()).toBe(true);
      await capture.click();
      await cameraButton(page, "Use photo").waitFor();
      await cameraButton(page, "Use photo").click();
      await expect
        .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
        .toBe(1);
      expect(fileChoosers()).toBe(0);
      expect(await page.getByRole("dialog", { name: "Take photo", exact: true }).count()).toBe(0);
    }),
  );

  it.each(
    (
      [
        ["iPhone Safari", "chat"],
        ["iPad desktop Safari", "new"],
        ["Android Chrome", "chat"],
        ["Android Firefox", "new"],
        ["Android WebView", "new"],
        ["Android unknown app", "chat"],
        ["Android native", "chat"],
        ["Android web chrome", "new"],
        ["unknown", "new"],
        ["macOS Safari", "new"],
        ["iOS in-app", "new"],
      ] as const
    ).map(([name, route]) => Object.assign({}, attachmentBrowser(name), { route })),
  )("preserves $name picker semantics in $route across widths", (fixture) =>
    withChat(
      { route: fixture.route, browser: fixture.name, preview: "permission-denied" },
      async (page) => {
        const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
        const items = page.locator(".agent-chat__attach-menu-option:visible");
        for (const [width, height] of [
          [390, 844],
          [1024, 768],
          [820, 1180],
          [932, 430],
        ] as const) {
          await page.setViewportSize({ width, height });
          await trigger.press("Enter");
          await attachmentOption(page, "file").waitFor({ state: "visible" });
          expect((await items.allTextContents()).map((text) => text.trim())).toEqual(
            fixture.single
              ? ["Photos & videos", "Attach…"]
              : ["Take photo", "Photos & videos", "File"],
          );
          await page.keyboard.press("Escape");
          await attachmentOption(page, "file").waitFor({ state: "hidden" });
        }
        if (fixture.nativeCapture) {
          const draft = page
            .locator(".agent-chat__composer-shell textarea, .new-session-page__composer textarea")
            .first();
          const draftText = "Keep this draft while taking a photo";
          await draft.fill(draftText);
          const chooser = await choose(page, "camera");
          expect(await page.getByRole("dialog", { name: "Take photo", exact: true }).count()).toBe(
            0,
          );
          expect(await page.locator("html").getAttribute("data-camera-requested")).toBeNull();
          await chooser.setFiles([]);
          expect(await draft.inputValue()).toBe(draftText);
          const photo = attachmentImage("camera.png");
          await (await choose(page, "camera")).setFiles(photo);
          const ready = page.locator('.chat-attachment-thumb[aria-busy="false"]');
          await expect.poll(() => ready.count()).toBe(1);
          expect(await page.locator(".agent-chat__camera-input").inputValue()).toBe("");
        } else if (!fixture.single) {
          await trigger.press("Enter");
          await page.getByRole("menuitem", { name: "Take photo", exact: true }).press("Enter");
          const dialog = page.getByRole("dialog", { name: "Take photo", exact: true });
          await dialog.waitFor();
          expect(await page.locator("html").getAttribute("data-camera-requested")).toBe("true");
          await cameraButton(page, "Cancel").click();
        }
      },
    ),
  );
});
