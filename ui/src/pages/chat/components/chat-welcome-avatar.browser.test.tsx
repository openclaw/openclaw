import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatWelcome } from "./chat-welcome.tsx";
import baseCss from "../../../styles/base.css?inline";
import composerCss from "../../../styles/chat/composer.css?inline";
import avatarCss from "../../../styles/identity-avatar.css?inline";

it("clips configured welcome images to a circle", async () => {
  const imageUrl = URL.createObjectURL(
    new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="teal"/></svg>',
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
    await expect
      .poll(
        () =>
          container.querySelector<HTMLImageElement>(".agent-chat__welcome-avatar img")
            ?.naturalWidth,
      )
      .toBe(96);
    const avatar = container.querySelector<HTMLElement>(
      ".agent-chat__welcome-avatar .identity-avatar--agent",
    )!;
    expect(getComputedStyle(avatar).borderRadius).toBe("50%");
    expect(getComputedStyle(avatar).overflow).toBe("hidden");
  } finally {
    unmount();
    URL.revokeObjectURL(imageUrl);
  }
});
