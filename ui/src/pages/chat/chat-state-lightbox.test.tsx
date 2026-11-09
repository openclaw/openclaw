import { flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ImageLightboxItemView } from "../../components/image-lightbox.tsx";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { AssistantAttachments } from "./components/chat-message-attachments-solid.tsx";

describe("image lightbox lifecycle", () => {
  it("accepts only matching base64 video at the page boundary", () => {
    const state = createPageState(
      createChatPageStateContext(),
      { afterCommit: () => () => {} },
      { dispatchEvent: () => true },
    );

    const source = "data:video/mp4;base64,AAAA";
    const mounted = mountSolid(() => (
      <AssistantAttachments
        attachments={[
          {
            type: "attachment",
            attachment: { kind: "video", label: "Clip", mimeType: "video/mp4", url: source },
          },
        ]}
        options={{ onOpenImage: state.handleOpenImage }}
      />
    ));
    const { container } = mounted;
    const player = container.querySelector("openclaw-chat-video-player")!;
    player.onExpand!(source);
    expect(state.imageLightbox?.src).toBe("data:video/mp4;base64,AAAA");

    state.handleOpenImage({ kind: "video", src: "data:audio/mp3;base64,AAAA", title: "Audio" });
    expect(state.imageLightbox).toBeNull();
    mounted.unmount();
  });

  it("clears the mounted preview when beginning a deferred image open", async () => {
    onTestFinished(installDialogPolyfill());
    const state = createPageState(
      createChatPageStateContext(),
      { afterCommit: () => () => {} },
      { dispatchEvent: () => true },
    );
    const release = vi.fn();
    state.imageLightbox = {
      src: "blob:managed-image",
      title: "Generated image",
      release,
    };
    const mounted = mountSolid(() => (
      <ImageLightboxItemView item={state.imageLightbox} onClose={state.handleCloseImage} />
    ));
    onTestFinished(mounted.unmount);
    expect(mounted.container.querySelector("openclaw-image-lightbox")).not.toBeNull();

    const requestVersion = state.beginImageOpen();

    expect(requestVersion).toBe(1);
    expect(state.imageLightbox).toBeNull();
    expect(release).toHaveBeenCalledOnce();
    flush();
    expect(mounted.container.querySelector("openclaw-image-lightbox")).toBeNull();
    mounted.unmount();
    // The removed lightbox's lazy import must settle before the worker resets its module graph.
    await vi.dynamicImportSettled();
  });
});
