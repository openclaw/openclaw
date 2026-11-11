import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatWelcome } from "./chat-welcome.tsx";
import baseCss from "../../../styles/base.css?inline";
import composerCss from "../../../styles/chat/composer.css?inline";
import avatarCss from "../../../styles/identity-avatar.css?inline";

const originalViewport = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each(
  [390, 1280].flatMap((viewportWidth) =>
    [
      { imageWidth: 96, imageHeight: 96 },
      { imageWidth: 160, imageHeight: 80 },
      { imageWidth: 80, imageHeight: 160 },
    ].map(({ imageWidth, imageHeight }) => ({ viewportWidth, imageWidth, imageHeight })),
  ),
)(
  "clips configured welcome images to a circle at $viewportWidth px ($imageWidth x $imageHeight)",
  async ({ viewportWidth, imageWidth, imageHeight }) => {
    await page.viewport(viewportWidth, 900);
    const imageUrl = URL.createObjectURL(
      new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}"><rect width="100%" height="100%" fill="teal"/></svg>`,
        ],
        { type: "image/svg+xml" },
      ),
    );
    const { container, unmount } = mountSolid(() => (
      <>
        <style>{`${baseCss}${composerCss}${avatarCss}`}</style>
        <ChatWelcome
          assistantName="Synthetic Guide"
          assistantAvatar={null}
          assistantAvatarUrl={imageUrl}
          onDraftChange={() => undefined}
          onSend={() => undefined}
        />
      </>
    ));
    try {
      const image = container.querySelector<HTMLImageElement>(".agent-chat__welcome-avatar img")!;
      await expect.poll(() => image.naturalWidth).toBe(imageWidth);
      // Intrinsic dimensions can arrive before the load handler reveals the image.
      await expect.poll(() => getComputedStyle(image).visibility).toBe("visible");
      expect(image.naturalHeight).toBe(imageHeight);
      const avatar = container.querySelector<HTMLElement>(
        ".agent-chat__welcome-avatar .identity-avatar--agent",
      )!;
      const size = viewportWidth === 390 ? 64 : 96;
      const bounds = avatar.getBoundingClientRect();
      expect(bounds.width).toBe(size);
      expect(bounds.height).toBe(size);
      expect(getComputedStyle(avatar).borderRadius).toBe("50%");
      expect(getComputedStyle(avatar).overflow).toBe("hidden");
      expect(getComputedStyle(image).objectFit).toBe("cover");
      expect(
        image.contains(document.elementFromPoint(bounds.left + size / 2, bounds.top + size / 2)),
      ).toBe(true);
      for (const x of [bounds.left + 1, bounds.right - 1]) {
        for (const y of [bounds.top + 1, bounds.bottom - 1]) {
          expect(avatar.contains(document.elementFromPoint(x, y))).toBe(false);
        }
      }
    } finally {
      unmount();
      URL.revokeObjectURL(imageUrl);
    }
  },
);
