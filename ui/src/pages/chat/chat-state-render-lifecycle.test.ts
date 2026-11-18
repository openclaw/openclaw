import { expect, it, onTestFinished, vi } from "vitest";
import { createChatState } from "./chat-state-controller.ts";

it.each(["complete", "cancel"] as const)(
  "releases only cancelled after-commit work (%s)",
  async (settlement) => {
    const controller = createChatState({ awaitDomCommit: async () => undefined });
    onTestFinished(controller.dispose);
    const release = vi.fn();
    let complete!: () => void;
    const cancel = controller.createRenderLifecycle().afterCommit((done) => {
      complete = done;
      return release;
    });
    await Promise.resolve();
    if (settlement === "complete") {
      complete();
    } else {
      cancel();
    }
    complete();
    cancel();
    controller.dispose();
    expect(release).toHaveBeenCalledTimes(settlement === "cancel" ? 1 : 0);
  },
);
