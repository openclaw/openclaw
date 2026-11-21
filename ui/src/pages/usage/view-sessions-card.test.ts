import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { mountView } from "./view-render.test-support.ts";
import { SessionsCard } from "./view-sessions-card.tsx";
import { createUsageProps, usageSession } from "./view.test-support.ts";

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
const session = (label: string) => ({ ...usageSession("session", "main", "openai"), label });
const withLatency = (label: string, p95Ms: number, durationMs?: number) => {
  const entry = session(label);
  if (!entry.usage) {
    throw new Error("usage fixture missing");
  }
  return {
    ...entry,
    usage: {
      ...entry.usage,
      ...(durationMs === undefined ? {} : { durationMs }),
      latency: { count: 75, avgMs: 183_649, p95Ms, minMs: 11_897, maxMs: 374_840 },
    },
  };
};
const renderSessions = (...sessions: ReturnType<typeof session>[]) =>
  mountView(() =>
    SessionsCard({
      sessions,
      selectedRows: [],
      usage: createUsageProps(),
      totalSessions: sessions.length,
    }),
  ).container;

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restorePropertyDescriptor(document, "execCommand", execCommandDescriptor);
});

it("puts the session turn p95 last in the row meta, after the wall-clock duration", () => {
  const owner = renderSessions(withLatency("long tail", 359_731, 324_000_000));
  const meta = owner.querySelector(".session-bar-meta")?.textContent ?? "";
  expect(meta).toContain("3d 18h · p95 6m");
});

it("leaves the p95 chip out when the session has no latency samples", () => {
  const owner = renderSessions(session("no turns"));
  const meta = owner.querySelector(".session-bar-meta")?.textContent ?? "";
  expect(meta).not.toContain("p95");
});

it("leaves the p95 chip out for zero or non-finite samples instead of showing a placeholder", () => {
  for (const p95Ms of [0, Number.NaN]) {
    const owner = renderSessions(withLatency("empty turns", p95Ms));
    const meta = owner.querySelector(".session-bar-meta")?.textContent ?? "";
    expect(meta).not.toContain("p95");
  }
});

it("retires changed copy payloads and announces success and failure until feedback expires", async () => {
  vi.useFakeTimers();
  const pending = createDeferred();
  const writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(undefined);
  const fallback = vi.fn(() => true);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
  const [sessions, setSessions] = createSignal([session("first")]);
  const { container: owner } = mountView(() =>
    SessionsCard({
      get sessions() {
        return sessions();
      },
      selectedRows: [],
      usage: createUsageProps(),
      totalSessions: 1,
    }),
  );
  const button = owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!;
  button.click();
  expect(writeText).toHaveBeenCalledOnce();

  setSessions([session("second")]);
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
  const statusText = () =>
    [...owner.querySelectorAll('.session-bar-actions [role="status"]')].map(
      (node) => node.textContent,
    );
  expect(statusText()).toEqual(["Copied"]);
  const feedback = owner.querySelector<HTMLElement>(".session-bar-copy-feedback")!;
  expect(feedback.hidden).toBe(false);
  expect(feedback.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1500);
  expect(statusText()).toEqual([""]);
  expect(feedback.hidden).toBe(true);

  fallback.mockReturnValue(false);
  writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
  owner.querySelector<HTMLButtonElement>(".session-bar-actions button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusText()).toEqual(["Couldn’t copy. Try again."]);
  expect(feedback.hidden).toBe(false);
  expect(feedback.textContent).toBe("Couldn’t copy. Try again.");
  await vi.advanceTimersByTimeAsync(2000);
  expect(statusText()).toEqual([""]);
  expect(feedback.hidden).toBe(true);
});
