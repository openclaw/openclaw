/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { DelegatedTask, DelegatedTaskGroup } from "../chat-delegation.ts";
import { ChatDelegation } from "./chat-delegation.tsx";

function group(count: number, status: DelegatedTask["status"]): DelegatedTaskGroup {
  return {
    key: "review",
    tasks: Array.from({ length: count }, (_, index) => ({
      runId: "child-" + index,
      childSessionKey: "agent:main:subagent:" + index,
      label: "Review section " + (index + 1),
      status,
      runtimeMs: 42_000,
      listed: true,
    })),
  };
}

it.each([1, 5, 6, 30])(
  "uses compact disclosure through five helpers and progress for %s helpers",
  (count) => {
    const [value, update] = createSignal(group(count, "running"));
    const onOpenSubagent = vi.fn();
    const { container } = mountSolid(() => (
      <ChatDelegation groups={[value()]} onOpenSubagent={onOpenSubagent} />
    ));
    const summary = container.querySelector<HTMLButtonElement>(".chat-delegation__summary")!;
    expect(summary.getAttribute("aria-expanded")).toBe(count > 5 ? "true" : "false");
    expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-valuemax")).toBe(
      count > 5 ? String(count) : undefined,
    );
    if (count <= 5) {
      summary.click();
      flush();
    }
    expect(container.querySelectorAll(".chat-delegation__task")).toHaveLength(count);
    container.querySelector<HTMLButtonElement>(".chat-delegation__name")!.click();
    expect(onOpenSubagent).toHaveBeenCalledWith("agent:main:subagent:0");
    update(group(count, "done"));
    flush();
    expect(container.textContent).toContain("Completed");
    expect(container.querySelector("[role=progressbar]")).toBeNull();
    // Explicitly opened small batches stay open; an untouched large batch compacts on completion.
    expect(summary.getAttribute("aria-expanded")).toBe(count <= 5 ? "true" : "false");
  },
);

it("keeps partial failure visible after compaction without claiming all tasks succeeded", () => {
  const value = group(6, "done");
  value.tasks[5]!.status = "timeout";
  const { container } = mountSolid(() => <ChatDelegation groups={[value]} />);
  expect(container.textContent).toContain("1 needing attention");
  expect(container.querySelector(".chat-delegation__group--failed")).not.toBeNull();
  container.querySelector<HTMLButtonElement>(".chat-delegation__summary")!.click();
  flush();
  expect(container.textContent).toContain("Timed out");
  expect(container.querySelectorAll(".chat-delegation__icon--done")).toHaveLength(5);
});

it("bounds large lists while keeping unfinished tasks visible and exact totals", () => {
  const value = group(70, "done");
  value.tasks[69]!.status = "running";
  const { container } = mountSolid(() => <ChatDelegation groups={[value]} />);
  expect(container.querySelectorAll(".chat-delegation__task")).toHaveLength(64);
  expect(container.textContent).toContain("Review section 70");
  expect(container.textContent).toContain("6 more tasks");
  expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-valuemax")).toBe("70");
});

it("shows missing historical outcomes rather than running forever or claiming success", () => {
  const value = group(40, "done");
  value.tasks.slice(32).forEach((task) => {
    task.status = "unknown";
  });
  const { container } = mountSolid(() => <ChatDelegation groups={[value]} />);
  expect(container.textContent).toContain("Outcome unavailable");
  expect(container.textContent).not.toContain("Completed");
  expect(container.querySelector("[role=progressbar]")).toBeNull();
  expect(container.querySelector(".chat-delegation__summary")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
});
