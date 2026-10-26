import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createChatMobileHostFixture } from "../chat-mobile-host.test-support.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { ChatDetails } from "./chat-details.tsx";

afterEach(cleanupSolid);

it("keeps Details in the mobile host through opening, parking, and returning", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  let updateHost!: (patch: Partial<ChatMobileHost>) => void;
  const close = vi.fn();
  const navigate = vi.fn();
  let details: ChatDetails | undefined;
  mountSolid(() => {
    const [host, setHost] = createSignal<ChatMobileHost>(
      createChatMobileHostFixture("details-mobile", {
        open: true,
        height: 280,
        reservedHeight: 280,
        destination: { area: "details" },
        detailsMount: target,
        navigate,
        close,
      }),
    );
    updateHost = (patch) => setHost((previous) => ({ ...previous, ...patch }));
    return createComponent(ChatDetails, {
      chat: {
        sessionKey: "agent:main:details-mobile",
        currentAgentId: "main",
        selectedSession: { key: "agent:main:details-mobile", kind: "direct" },
        messages: [],
        gatewayScope: {},
        detailsWorkspace: { root: "/workspace/mobile", label: "mobile" },
      },
      elements: undefined,
      mobile: true,
      get mobileHost() {
        return host();
      },
      presentation: true,
      setRef: (handle) => (details = handle),
    });
  });
  try {
    flush();
    const panel = target.querySelector<HTMLElement>(".chat-details")!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(false);
    expect(panel.matches(":popover-open")).toBe(false);
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    // The outer host commit does not include this production lazy import.
    await customElements.whenDefined("openclaw-chat-details-mobile-host-content");
    await expect.poll(() => panel.querySelector(".chat-details-mobile-root")).not.toBeNull();
    const content = panel.firstElementChild;
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();

    updateHost({ open: false });
    flush();
    expect(panel.hidden).toBe(true);
    updateHost({ open: true, suspended: true });
    flush();
    expect(panel.hidden).toBe(true);
    updateHost({ suspended: false });
    flush();
    expect(panel.hidden).toBe(false);
    expect(panel.firstElementChild).toBe(content);
    expect(target.querySelectorAll(".chat-details")).toHaveLength(1);
    details!.open(document.body);
    expect(navigate).toHaveBeenCalledWith({ area: "details" }, document.body);
  } finally {
    target.remove();
  }
});
