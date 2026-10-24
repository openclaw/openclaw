/* @vitest-environment jsdom */

import { createRoot, createSignal, onSettled } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  ChatAttachmentAdmission,
  createChatAttachmentAdmission,
} from "./chat-message-attachment-admission-solid.tsx";

it("does not acquire an observer when its ref retires the owner before settlement", () => {
  const observe = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = observe;
      disconnect() {}
    },
  );
  let settled = false;
  const view = mountSolid(() =>
    createRoot((dispose) => {
      onSettled(() => {
        settled = true;
      });
      return (
        <ChatAttachmentAdmission
          attachments={[{ kind: "document", label: "Notes", url: "https://example.test/notes" }]}
          options={{}}
          render={(admission) => (
            <button
              ref={(element) => {
                admission.observeElement?.(element);
                dispose();
              }}
            />
          )}
        />
      );
    }),
  );
  try {
    expect(settled).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});

it("retires admissions and reobserves the retained element for a new source", async () => {
  const observers: Array<{ show: () => void; element?: Element; disconnected: boolean }> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = {
          show: () =>
            callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
          disconnected: false,
        };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.element = element;
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  const [scope, setScope] = createSignal("first-source");
  let admission: ReturnType<typeof createChatAttachmentAdmission> | undefined;
  const view = mountSolid(() => {
    admission = createChatAttachmentAdmission(scope, () => false);
    return <button ref={admission.observeElement}>Annotation</button>;
  });
  try {
    await waitForSolid(() => expect(observers).toHaveLength(1));
    expect(admission!.admitted).toBe(false);
    setScope("second-source");
    flush();
    await waitForSolid(() => expect(observers).toHaveLength(2));
    expect(observers[0]!.disconnected).toBe(true);
    expect(observers[1]!.element).toBe(observers[0]!.element);
    observers[0]!.show();
    await Promise.resolve();
    expect(admission!.admitted).toBe(false);
    observers[1]!.show();
    flush();
    expect(admission!.admitted).toBe(true);
    setScope("third-source");
    flush();
    expect(admission!.admitted).toBe(false);
    view.unmount();
    observers[2]!.show();
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});
