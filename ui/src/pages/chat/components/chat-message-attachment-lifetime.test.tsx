/* @vitest-environment jsdom */

import { createRoot, onSettled } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";

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
