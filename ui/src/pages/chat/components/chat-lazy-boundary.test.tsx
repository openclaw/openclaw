/* @vitest-environment jsdom */
import { createSignal, lazy } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

it("isolates a failed lazy region and retries it without replacing the composer", async () => {
  const retry = createDeferred<{ default: () => string }>();
  const load = vi
    .fn<() => Promise<{ default: () => string }>>()
    .mockRejectedValueOnce(new Error("Chat details could not load"))
    .mockReturnValueOnce(retry.promise);
  const Details = lazy(load);
  const view = mountSolid(() => {
    const [draft, setDraft] = createSignal("Keep this draft");
    return (
      <>
        <input
          aria-label="Message"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <ChatLazyBoundary fallback={<span>Loading details</span>}>
          <Details />
        </ChatLazyBoundary>
      </>
    );
  });
  onTestFinished(view.unmount);
  const composer = view.container.querySelector("input")!;
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
  expect(view.container.textContent).toContain("Chat details could not load");
  composer.value = "Still editable";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(load).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector("input")).toBe(composer);
  expect(composer.value).toBe("Still editable");
  retry.resolve({ default: () => "Recovered details" });
  await waitForSolid(() => expect(view.container.textContent).toContain("Recovered details"));
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.querySelector("input")).toBe(composer);
});
