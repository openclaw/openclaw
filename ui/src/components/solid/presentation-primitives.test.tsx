import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completePanelRefresh,
  type PanelRefreshStatus as RefreshStatus,
} from "../panel-refresh-status-state.ts";
import { AgentStartupState, LazyViewError, PanelErrorState } from "./lazy-view-error.tsx";
import { LoadingState } from "./loading-state.tsx";
import "./panel-empty-state.tsx";
import { PanelIconButton } from "./panel-icon-button.tsx";
import type { PanelLoadingSkeletonVariant } from "./panel-loading-skeleton.tsx";
import "./panel-loading-skeleton.tsx";
import { PanelRefreshStatus } from "./panel-refresh-status.tsx";

afterEach(async () => {
  cleanup();
  // Registered bridge tags defer disposal so same-turn reparenting keeps their roots.
  await Promise.resolve();
});

describe("Solid presentation primitives", () => {
  it("preserves the labeled empty state and its actionable content", async () => {
    const action = vi.fn();
    const [heading, setHeading] = createSignal("No files");
    const view = render(() => (
      <openclaw-panel-empty-state
        prop:heading={heading()}
        prop:description="Choose a workspace to browse its files."
      >
        <svg viewBox="0 0 24 24">
          <path d="M1 1h10" />
        </svg>
        <span slot="action">
          <button type="button" onClick={action}>
            Choose workspace
          </button>
        </span>
      </openclaw-panel-empty-state>
    ));
    const host = view.container.querySelector("openclaw-panel-empty-state")!;
    await host.updateComplete;
    expect(view.getByRole("status").textContent).toContain("No files");
    expect(view.container.querySelector("svg")?.closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Choose workspace" }));
    expect(action).toHaveBeenCalledOnce();
    setHeading("No matching files");
    flush();
    await host.updateComplete;
    expect(view.getByRole("status").textContent).toContain("No matching files");
  });

  it.each([
    ["board", ".board-grid .widget", 4],
    ["browser", ".viewport", 1],
    ["chat", ".bubble", 3],
    ["discussion", ".discussion-frame", 1],
    ["document", ".code .line", 5],
    ["file-list", ".rows .row", 5],
    ["files", ".rows .row", 5],
    ["review", ".summary .pill", 2],
    ["terminal", ".terminal .line", 4],
  ] satisfies Array<[PanelLoadingSkeletonVariant, string, number]>)(
    "renders the %s loading structure",
    async (variant, selector, count) => {
      const view = render(() => (
        <openclaw-panel-loading-skeleton prop:variant={variant} prop:label="Loading panel" />
      ));
      await view.container.querySelector("openclaw-panel-loading-skeleton")!.updateComplete;
      expect(view.container.querySelectorAll(selector)).toHaveLength(count);
    },
  );

  it("switches the loading structure and updates desktop status without stale content", async () => {
    const [variant, setVariant] = createSignal<PanelLoadingSkeletonVariant>("terminal");
    const [label, setLabel] = createSignal("Connecting");
    const view = render(() => (
      <openclaw-panel-loading-skeleton prop:variant={variant()} prop:label={label()} />
    ));
    const host = view.container.querySelector("openclaw-panel-loading-skeleton")!;
    await host.updateComplete;
    setVariant("desktop");
    flush();
    await host.updateComplete;
    expect(view.container.querySelector(".terminal")).toBeNull();
    expect(view.getByText("Connecting")).toBeTruthy();
    expect(view.container.querySelector(".desktop-spinner")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    setLabel("Authenticating");
    flush();
    await host.updateComplete;
    expect(view.queryByText("Connecting")).toBeNull();
    expect(view.getByText("Authenticating")).toBeTruthy();
  });

  it("announces loading and startup states while keeping decorative skeletons hidden", () => {
    const view = render(() => (
      <>
        <LoadingState />
        <AgentStartupState />
      </>
    ));
    expect(view.getAllByRole("status")).toHaveLength(2);
    expect(view.getByRole("status", { name: "Loading…" })).toBeTruthy();
    expect(view.container.querySelector(".loading-skeleton")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(view.container.querySelector(".agent-startup-state")?.textContent).not.toBe("");
  });

  it("hides expected gateway interruptions, then presents hard and stale-only failures", () => {
    const [status, setStatus] = createSignal<RefreshStatus>({
      ...completePanelRefresh(),
      stale: true,
      awaitingGateway: true,
    });
    const view = render(() => <PanelRefreshStatus status={status()} />);
    expect(view.container.textContent).toBe("");
    setStatus({ ...completePanelRefresh(), error: "Synthetic read failure", stale: true });
    flush();
    expect(view.getByRole("alert").textContent).toContain("Synthetic read failure");
    expect(view.getByRole("alert").textContent).toContain("Showing stale data");
    expect(view.queryByRole("button")).toBeNull();
    setStatus({ ...completePanelRefresh(), stale: true });
    flush();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("Showing stale data");
    setStatus(completePanelRefresh());
    flush();
    expect(view.container.textContent).toBe("");
  });

  it("retains prior content with a recoverable error and forwards retry and close actions", () => {
    const retry = vi.fn();
    const close = vi.fn();
    const original = vi.fn();
    const [updated, setUpdated] = createSignal(false);
    const view = render(() => (
      <LazyViewError
        error={new Error("Synthetic module load failure")}
        stale
        subtitle="Workspace panel"
        render={() => <p>Last loaded panel</p>}
        onRetry={updated() ? retry : original}
        onClose={updated() ? close : original}
      />
    ));
    expect(view.getByText("Last loaded panel")).toBeTruthy();
    expect(view.getByRole("alert").classList.contains("lazy-view-error--inline")).toBe(true);
    expect(view.getByRole("alert").classList.contains("lazy-view-error--stale")).toBe(true);
    expect(view.getByText("Workspace panel")).toBeTruthy();
    expect(view.container.querySelector("details code")?.textContent).toContain(
      "Synthetic module load failure",
    );
    setUpdated(true);
    flush();
    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });

  it("supports non-alert panel errors with no details or actions", () => {
    const view = render(() => (
      <PanelErrorState title="Panel unavailable" subtitle="Reconnect to continue." role="status" />
    ));
    expect(view.getByRole("status").textContent).toContain("Reconnect to continue.");
    expect(view.container.querySelector("details")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });

  it("keeps icon-button semantics synchronized with disabled and busy props", () => {
    const click = vi.fn();
    const original = vi.fn();
    const [busy, setBusy] = createSignal(true);
    const view = render(() => (
      <PanelIconButton
        label="Open file"
        icon={<svg aria-hidden="true" />}
        onClick={busy() ? original : click}
        class="panel-action"
        disabled={busy()}
        busy={busy()}
        newTab
      />
    ));
    const button = view.getByRole<HTMLButtonElement>("button", { name: "Open file" });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("data-new-tab-action")).toBe(true);
    setBusy(false);
    flush();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });
});
