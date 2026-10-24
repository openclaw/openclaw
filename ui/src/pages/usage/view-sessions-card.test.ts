import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { SessionsCard } from "./view-sessions-card.tsx";
import { createUsageProps, usageSession } from "./view.test-support.ts";

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restorePropertyDescriptor(document, "execCommand", execCommandDescriptor);
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
  const [sessions, setSessions] = createSignal([
    { ...usageSession("session", "main", "openai"), label: "first" },
  ]);
  mountSolid(
    () =>
      SessionsCard({
        get sessions() {
          return sessions();
        },
        usage: createUsageProps(),
        totalSessions: 1,
      }),
    { container: owner },
  );
  flush();
  const button = owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!;
  button.click();
  expect(writeText).toHaveBeenCalledOnce();

  setSessions([{ ...usageSession("session", "main", "openai"), label: "second" }]);
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

it("announces usage session label copy feedback in a status region", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  const owner = document.body.appendChild(document.createElement("section"));
  mountSolid(
    () =>
      SessionsCard({
        sessions: [{ ...usageSession("session", "main", "openai"), label: "first" }],
        usage: createUsageProps(),
        totalSessions: 1,
      }),
    { container: owner },
  );
  flush();
  const statusText = () =>
    [...owner.querySelectorAll('.session-bar-actions [role="status"]')].map(
      (node) => node.textContent,
    );
  owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusText()).toEqual(["Copied!"]);
  const feedback = owner.querySelector<HTMLElement>(".session-bar-copy-feedback")!;
  expect(feedback.hidden).toBe(false);
  expect(feedback.textContent).toBe("Copied!");
  await vi.advanceTimersByTimeAsync(1500);
  expect(statusText()).toEqual([""]);
  expect(feedback.hidden).toBe(true);

  writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
  owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusText()).toEqual(["Copy failed"]);
  expect(feedback.hidden).toBe(false);
  expect(feedback.textContent).toBe("Copy failed");
  await vi.advanceTimersByTimeAsync(2000);
  expect(statusText()).toEqual([""]);
  expect(feedback.hidden).toBe(true);
});
