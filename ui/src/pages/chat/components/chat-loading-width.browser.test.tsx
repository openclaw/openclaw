import { createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { createFrameClock } from "../../../test-helpers/animation-frame-clock.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import { ChatConversationMobile } from "./chat-conversation-presentation.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { requireElement, threadProps } from "./chat-transcript.test-support.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/composer-surface.css";

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatThreadState("loading-width");
});

it.each([
  { width: 1280, details: 0, mobile: false, savedWidth: "" },
  { width: 1280, details: 320, mobile: false, savedWidth: "" },
  { width: 1280, details: 0, mobile: false, savedWidth: "600px" },
  { width: 820, details: 0, mobile: false, savedWidth: "" },
  { width: 820, details: 320, mobile: false, savedWidth: "" },
  { width: 400, details: 0, mobile: true, savedWidth: "" },
])(
  "keeps loading and loaded columns aligned at $width px with $details px details and $savedWidth saved width",
  async ({ width, details, mobile, savedWidth }) => {
    await page.viewport(width, 800);
    const clock = createFrameClock();
    vi.stubGlobal("requestAnimationFrame", clock.request);
    vi.stubGlobal("cancelAnimationFrame", clock.cancel);
    const transcript = createChatTranscript(() => "loading-width");
    onTestFinished(() => transcript.dispose());
    const [props, setProps] = createSignal(
      threadProps("loading-width", undefined, [], {
        loading: true,
        routeLoadingSkeleton: true,
      }),
    );
    const view = mountSolid(() => (
      <div class="sidebar-region sidebar-region--desktop" style={{ height: "800px" }}>
        <section
          class="chat"
          style={{ "grid-area": "main", "--chat-thread-max-width": savedWidth || "48rem" }}
        >
          <div
            class="chat-main__conversation-frame"
            style={{ "--chat-details-space": details + "px" }}
          >
            <div class="chat-main__conversation">
              <ChatConversationMobile value={() => mobile}>
                <ChatThread props={props()} transcript={transcript} />
              </ChatConversationMobile>
            </div>
          </div>
        </section>
      </div>
    ));
    view.container.style.cssText = "position: fixed; inset: 0";
    flush();
    transcript.start();
    transcript.update();
    const bounds = () =>
      requireElement(view.container, ".chat-conversation-loading > div").getBoundingClientRect();
    const cold = bounds();
    clock.flush(performance.now());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    flush();
    clock.flush(performance.now());
    flush();
    const loading = mobile ? bounds() : null;
    setProps(threadProps("loading-width", undefined, [], { loading: true }));
    flush();
    const refreshLoading = mobile ? bounds() : null;
    setProps(threadProps("loading-width"));
    flush();
    transcript.update();
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-virtual-row")).not.toBeNull(),
    );
    const loaded = requireElement(view.container, ".chat-thread-inner").getBoundingClientRect();
    expect(loaded.width).toBeGreaterThan(0);
    for (const pending of [cold, loading, refreshLoading].filter((value) => value !== null)) {
      expect(pending.left).toBeCloseTo(loaded.left, 0);
      expect(pending.width).toBeCloseTo(loaded.width, 0);
    }
  },
);
