import { render } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { GatewayStatus } from "../../lib/gateway-status.ts";
import { GatewayConnectionView, GatewaySidebarSkeleton } from "./gateway-connection-view.tsx";

const reload = async () => true;

const states: Array<[GatewayStatus, string, string | null]> = [
  ["connecting", "Connecting to OpenClaw", null],
  ["starting", "OpenClaw is waking up", null],
  ["restarting", "OpenClaw is restarting", null],
  ["reconnecting", "Still connecting", null],
  ["suspending", "OpenClaw is pausing", null],
  ["suspended", "OpenClaw is paused", null],
  ["restoring", "Welcome back", null],
  ["offline", "Couldn’t reach the Gateway", "Try again"],
  ["reload-required", "OpenClaw was updated", "Reload page"],
];

it.each(states)("pairs %s copy with an actionable control", (kind, title, action) => {
  const onRetry = vi.fn();
  const onReload = vi.fn(async () => true);
  const view = render(() => (
    <GatewayConnectionView kind={kind} retryPending={false} onRetry={onRetry} onReload={onReload} />
  ));
  expect(view.getByRole("heading", { name: title })).toBeDefined();
  const buttons = view.queryAllByRole("button");
  expect(buttons).toHaveLength(action ? 1 : 0);
  if (action) {
    view.getByRole("button", { name: action }).click();
    expect(action === "Try again" ? onRetry : onReload).toHaveBeenCalledOnce();
    expect(view.container.textContent).not.toContain("keep trying");
  }
  expect(view.container.textContent).not.toContain("Your workspaceYour workspace");
  view.unmount();
});

it("does not offer manual retry when an automatic retry is scheduled", () => {
  const view = render(() => (
    <GatewayConnectionView
      kind="offline"
      retryPending={false}
      reconnectAt={Date.now() + 1000}
      onRetry={vi.fn()}
      onReload={reload}
    />
  ));
  expect(view.getByRole("heading", { name: "Still connecting" })).toBeDefined();
  expect(view.queryAllByRole("button")).toHaveLength(0);
  expect(view.container.textContent).toContain("keep trying");
  view.unmount();
});

it("uses a decorative sidebar skeleton rather than invented session text", () => {
  const view = render(() => <GatewaySidebarSkeleton />);
  expect(
    view.container.querySelector(".sidebar-connection-skeleton")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(view.container.querySelectorAll(".sidebar-connection-skeleton__row")).toHaveLength(4);
  expect(view.container.textContent?.trim()).toBe("");
  view.unmount();
});

it("describes an active attempt instead of offering an unavailable retry", () => {
  const view = render(() => (
    <GatewayConnectionView kind="offline" retryPending={true} onRetry={vi.fn()} onReload={reload} />
  ));
  expect(view.getByRole("heading", { name: "Connecting to OpenClaw" })).toBeDefined();
  expect(view.queryAllByRole("button")).toHaveLength(0);
  expect(view.container.textContent).not.toContain("try again");
  view.unmount();
});

it("distinguishes a cold retry from the first connection attempt", () => {
  const view = render(() => (
    <GatewayConnectionView
      kind="connecting"
      hasFailedAttempt
      retryPending
      onRetry={vi.fn()}
      onReload={reload}
    />
  ));
  expect(view.getByRole("heading", { name: "Still connecting" })).toBeDefined();
  expect(view.queryAllByRole("button")).toHaveLength(0);
  view.unmount();
});
