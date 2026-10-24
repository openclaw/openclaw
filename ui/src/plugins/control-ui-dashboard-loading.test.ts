/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import "./control-ui-dashboard.tsx";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, started: false };
});

vi.mock("../components/board/board-view.tsx", async (original) => {
  loading.started = true;
  await loading.promise;
  return original();
});

it("loads the board runtime on mount and keeps dashboard chrome while its empty state waits", async () => {
  onTestFinished(loading.release);
  const element = document.createElement("openclaw-plugin-session-dashboard");
  document.body.append(element);
  onTestFinished(() => element.remove());
  await element.updateComplete;

  await vi.waitFor(() => expect(loading.started).toBe(true));
  const toggle = element.querySelector<HTMLButtonElement>(".plugin-session-dashboard__toggle")!;
  expect(toggle).not.toBeNull();
  toggle.click();
  await element.updateComplete;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(element.querySelector(".plugin-session-dashboard__empty")).toBeNull();

  loading.release();
  await vi.waitFor(() =>
    expect(element.querySelector(".plugin-session-dashboard__empty")).not.toBeNull(),
  );
  expect(element.querySelector(".plugin-session-dashboard__toggle")).toBe(toggle);
});
