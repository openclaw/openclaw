import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { SessionBarRow } from "./view-session-row.tsx";

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

it("retires pending usage session label copying when its payload changes", async () => {
  vi.useFakeTimers();
  const pending = createDeferred();
  const writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(undefined);
  const fallback = vi.fn(() => true);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
  const owner = document.body.appendChild(document.createElement("section"));
  const [label, setLabel] = createSignal("first");
  mountSolid(
    () =>
      SessionBarRow({
        sessionKey: "session",
        get displayLabel() {
          return label();
        },
        meta: [],
        agentId: undefined,
        valueLabel: "0",
        isSelected: false,
        onSelect: vi.fn(),
      }),
    { container: owner },
  );
  flush();
  const button = owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!;
  button.click();
  expect(writeText).toHaveBeenCalledOnce();

  setLabel("second");
  flush();
  const current = owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!;
  const availableBeforeSettlement = !current.disabled;
  pending.reject(new Error("Synthetic clipboard rejection"));
  await vi.advanceTimersByTimeAsync(0);

  expect(fallback).not.toHaveBeenCalled();
  expect(availableBeforeSettlement).toBe(true);
  expect(current.dataset.copyState).toBeUndefined();
  current.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText.mock.lastCall?.[0]).toContain("second");
  expect(current.dataset.copyState).toBe("copied");
});
