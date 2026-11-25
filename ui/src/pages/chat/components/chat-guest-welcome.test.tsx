import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import type {
  GuestWelcomeHandle,
  GuestWelcomePresentation,
} from "../../../app/guest-welcome-handle.ts";
import { HomeSessionUnavailable } from "../../../components/home-session-unavailable.tsx";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { renderChatComposerNotices as ChatComposerNotices } from "../chat-view-notices.tsx";

function welcomeOwner() {
  let presentation: GuestWelcomePresentation = { kind: "hidden" };
  const listeners = new Set<() => void>();
  const publish = (next: GuestWelcomePresentation) => {
    presentation = next;
    listeners.forEach((listener) => listener());
  };
  const owner: GuestWelcomeHandle = {
    get presentation() {
      return presentation;
    },
    retry: vi.fn(() => publish({ kind: "pending" })),
    start: () => () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { owner, publish, listeners };
}

it.each(["chat", "home"])(
  "keeps %s guest status tied to the live owner across lazy presentation",
  async (surface) => {
    const first = welcomeOwner();
    const second = welcomeOwner();
    const [owner, setOwner] = createSignal(first.owner);
    const context = {
      get guestWelcome() {
        return owner();
      },
    } as ApplicationContext;
    const { container, unmount } = mountSolid(() =>
      surface === "chat" ? (
        <ChatComposerNotices messages={[]} guestWelcome={owner()} />
      ) : (
        <ApplicationProvider value={context}>
          <HomeSessionUnavailable agentId="main" />
        </ApplicationProvider>
      ),
    );
    expect(container.querySelector(".chat-guest-welcome-status")).toBeNull();
    expect(first.listeners.size).toBe(1);

    first.publish({ kind: "pending" });
    await waitForSolid(() =>
      expect(
        container.querySelector('.chat-guest-welcome-status [role="status"]')?.textContent,
      ).toContain("Setting up your welcome session…"),
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    first.publish({ kind: "failed", message: "<img src=x onerror=alert(1)>" });
    await waitForSolid(() =>
      expect(
        container.querySelector('.chat-guest-welcome-status [role="alert"]')?.textContent,
      ).toContain("Couldn’t set up your welcome session. Try again. <img src=x onerror=alert(1)>"),
    );
    expect(container.querySelector("img")).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-guest-welcome-status button")!.click();
    expect(first.owner.retry).toHaveBeenCalledOnce();
    await waitForSolid(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());

    second.publish({ kind: "failed", message: null });
    setOwner(second.owner);
    await waitForSolid(() =>
      expect(
        container.querySelector('.chat-guest-welcome-status [role="alert"]')?.textContent,
      ).toContain("Couldn’t set up your welcome session. Try again."),
    );
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    first.publish({ kind: "pending" });
    flush();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-guest-welcome-status button")!.click();
    expect(second.owner.retry).toHaveBeenCalledOnce();
    expect(first.owner.retry).toHaveBeenCalledOnce();
    second.publish({ kind: "hidden" });
    await waitForSolid(() =>
      expect(container.querySelector(".chat-guest-welcome-status")).toBeNull(),
    );
    unmount();
    expect(second.listeners.size).toBe(0);
  },
);
