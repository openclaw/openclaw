/* @vitest-environment jsdom */
import type { ComponentProps } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatPastedText } from "./chat-pasted-text.tsx";

afterEach(() => vi.unstubAllGlobals());

function pendingFetch() {
  const requests: (Pick<PromiseWithResolvers<Response>, "resolve" | "reject"> & {
    signal: AbortSignal;
  })[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_src, init) => {
      const response = Promise.withResolvers<Response>();
      // Deliberately allow late delivery after abort to exercise source retirement.
      requests.push({ signal: init!.signal!, resolve: response.resolve, reject: response.reject });
      return response.promise;
    }),
  );
  onTestFinished(() =>
    requests.forEach(({ reject }) => reject(new DOMException("Test finished", "AbortError"))),
  );
  return requests;
}

function mountPaste(initial: ComponentProps<typeof ChatPastedText>) {
  const view = mountSolid(ChatPastedText, initial);
  document.body.append(view.container);
  onTestFinished(view.dispose);
  return view;
}

it.each(["src", "sizeBytes", "scope"] as const)(
  "retires excerpt work when %s changes and when the card is disposed",
  async (field) => {
    const requests = pendingFetch();
    const initial = { src: "/paste.txt", scope: "first", sizeBytes: 20 };
    const view = mountPaste(initial);
    const chip = view.container.querySelector<HTMLElement>(".chat-attachment-thumb")!;
    chip.focus();
    const replacement = {
      ...initial,
      [field]: field === "src" ? "/next.txt" : field === "sizeBytes" ? 30 : "second",
    };
    view.update(replacement);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.signal.aborted).toBe(false);
    expect(chip.textContent).toBe("Pasted text");

    requests[0]!.resolve(new Response("Outdated excerpt"));
    await vi.dynamicImportSettled();
    expect(chip.textContent).toBe("Pasted text");
    requests[1]!.resolve(new Response("# Current **excerpt**"));
    await waitForSolid(() => expect(chip.textContent).toBe("Current excerpt"));
    expect(view.container.querySelector(".chat-attachment-thumb")).toBe(chip);
    expect(document.activeElement).toBe(chip);
    const onOpen = vi.fn();
    view.update({ ...replacement, onOpen });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.signal.aborted).toBe(false);
    chip.click();
    expect(onOpen).toHaveBeenCalledOnce();

    view.update({ ...replacement, src: "/pending.txt" });
    expect(chip.textContent).toBe("Pasted text");
    expect(requests).toHaveLength(3);
    view.dispose();
    expect(requests[2]!.signal.aborted).toBe(true);
    requests[2]!.resolve(new Response("Disposed excerpt"));
    await vi.dynamicImportSettled();
    expect(view.container.childElementCount).toBe(0);
  },
);

it("keeps the generic card usable without a source and after an excerpt failure", async () => {
  const requests = pendingFetch();
  const onOpen = vi.fn();
  const view = mountPaste({ scope: "first", onOpen });
  const chip = view.container.querySelector<HTMLElement>(".chat-attachment-thumb")!;
  expect(requests).toHaveLength(0);
  expect(chip.textContent).toBe("Pasted text");
  chip.click();
  expect(onOpen).toHaveBeenCalledTimes(1);

  view.update({ scope: "first", src: "/unavailable.txt", onOpen });
  requests[0]!.reject(new Error("Unavailable excerpt"));
  await vi.dynamicImportSettled();
  expect(view.container.querySelector(".chat-attachment-thumb")).toBe(chip);
  expect(chip.textContent).toBe("Pasted text");
  expect(view.container.querySelector("[role=alert]")).toBeNull();
  chip.click();
  expect(onOpen).toHaveBeenCalledTimes(2);
});
