/* @vitest-environment jsdom */

import { render as mountSolid } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { SidebarUpdateCard, type SidebarUpdateCardProps } from "./sidebar-update-card.tsx";

let originalWebkit: PropertyDescriptor | undefined;
const disposers: Array<() => void> = [];
async function settle() {
  await Promise.resolve();
  flush();
}
async function mount(
  update: UpdateAvailable | null,
  schedule: UpdateScheduleState | null = null,
  canUpdate = true,
  canHoldUpdate = true,
) {
  const [props, set] = createSignal<Partial<SidebarUpdateCardProps>>({
    updateAvailable: update,
    updateSchedule: schedule,
    canUpdate,
    canHoldUpdate,
  });
  const element = document.createElement("div");
  document.body.append(element);
  const unmount = mountSolid(() => <SidebarUpdateCard {...props()} />, element);
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unmount();
    element.remove();
  };
  disposers.push(dispose);
  await settle();
  return {
    element,
    props,
    setProps: (value: Partial<SidebarUpdateCardProps>) =>
      set((previous) => ({ ...previous, ...value })),
    dispose,
  };
}

beforeEach(() => {
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
});

describe("SidebarUpdateCard", () => {
  it("restores an actionable retry after stale-client recovery cannot reach the Gateway", async () => {
    const element = await mount(null);
    let completeRefresh: ((reloading: boolean) => void) | undefined;
    const firstRefresh = new Promise<boolean>((resolve) => {
      completeRefresh = resolve;
    });
    const onRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(firstRefresh)
      .mockResolvedValue(false);
    element.setProps({ refreshRequired: true });
    element.setProps({ onRefresh });
    await settle();

    const action = element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    action?.click();
    await settle();

    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Reloading…");
    action?.click();
    expect(onRefresh).toHaveBeenCalledOnce();

    completeRefresh?.(false);
    await vi.waitFor(() => expect(action?.disabled).toBe(false));
    expect(element.element.textContent).toContain(
      "Actions are unavailable while the Gateway reconnects.",
    );
    expect(action?.textContent).toContain("Retry now");

    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("ignores an obsolete refresh result after recovery state is re-established", async () => {
    const element = await mount(null);
    let completeFirst: ((reloading: boolean) => void) | undefined;
    let completeSecond: ((reloading: boolean) => void) | undefined;
    const onRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          completeFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          completeSecond = resolve;
        }),
      );
    element.setProps({ refreshRequired: true });
    element.setProps({ onRefresh });
    await settle();

    element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    await settle();

    element.setProps({ refreshRequired: false });
    await settle();
    element.setProps({ refreshRequired: true });
    await settle();
    const action = element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    action?.click();
    await settle();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(action?.disabled).toBe(true);

    completeFirst?.(false);
    await settle();
    expect(action?.disabled).toBe(true);
    expect(element.element.textContent).not.toContain(
      "Actions are unavailable while the Gateway reconnects.",
    );

    completeSecond?.(false);
    await vi.waitFor(() => expect(action?.disabled).toBe(false));
    expect(element.element.textContent).toContain(
      "Actions are unavailable while the Gateway reconnects.",
    );
  });

  it("gives the refresh state precedence over an available update", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onRefresh = vi.fn(async () => false);
    const onUpdate = vi.fn();
    element.setProps({ refreshRequired: true });
    element.setProps({ onRefresh });
    await settle();
    element.setProps({ onUpdate });
    await settle();

    const card = element.element.querySelector(".sidebar-update-card");
    expect(card?.getAttribute("role")).toBe("status");
    expect(card?.getAttribute("aria-live")).toBe("polite");
    expect(element.element.querySelector(".sidebar-update-card__title")?.textContent).toBe(
      "Server updated",
    );
    expect(element.element.querySelector(".sidebar-update-card__subtitle")?.textContent).toBe(
      "Refresh for full capabilities",
    );
    expect(element.element.textContent).not.toContain("Update Gateway");
    expect(element.element.textContent).not.toContain("v2.0.0");
    element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("routes a recorded failure to update settings when availability is gone", async () => {
    const element = await mount(null);
    const onReviewUpdate = vi.fn();
    element.setProps({ statusBanner: { tone: "danger", text: "Update failed" } });
    element.setProps({ onReviewUpdate });
    await settle();

    expect(element.element.textContent).toContain("Update failed");
    element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__review")?.click();
    expect(onReviewUpdate).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps live run controls focused until acknowledgement (compact: %s)",
    async (compact) => {
      const element = await mount(null);
      element.setProps({ compact, updateRun: createUpdateRunFixture() });
      await settle();
      expect(element.element.textContent).toContain("OpenClaw update in progress: staging");
      expect(element.element.textContent).toContain("phases complete");
      const action = element.element.querySelector<HTMLButtonElement>(
        ".sidebar-update-card__action",
      )!;
      const details = element.element.querySelector("details");
      if (details) {
        details.open = true;
      }
      expect(action.disabled).toBe(false);
      action.focus();
      expect(document.activeElement).toBe(action);

      element.setProps({
        updateRun: createUpdateRunFixture({ phase: "verifying", updatedAtMs: 3 }),
      });
      await settle();
      expect(element.element.textContent).toContain("OpenClaw update in progress: verifying");
      expect(element.element.querySelector(".sidebar-update-card__action")).toBe(action);
      expect(document.activeElement).toBe(action);
      if (details) {
        expect(element.element.querySelector("details")).toBe(details);
        expect(details.open).toBe(true);
      }

      element.setProps({
        updateRun: createUpdateRunFixture({
          status: "succeeded",
          phase: "finished",
          finishedAtMs: Date.now(),
          after: { version: "2026.9.2" },
        }),
      });
      await settle();
      expect(element.element.textContent).toContain("OpenClaw updated to 2026.9.2");
      element.setProps({ updateRunAcknowledged: true });
      await settle();
      expect(element.element.querySelector(".sidebar-update-card")).toBeNull();
      element.setProps({ updateRunAcknowledged: false });
      element.setProps({
        updateRun: { ...element.props().updateRun, finishedAtMs: Date.now() - 24 * 60 * 60 * 1000 },
      });
      await settle();
      expect(element.element.querySelector(".sidebar-update-card")).toBeNull();
    },
  );

  it("renders an available update and narrates it after the Gateway drops its metadata", async () => {
    const element = await mount(
      {
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        channel: "dev",
        commitsBehind: 246,
        currentSha: "1234567890abcdef",
        upstreamSha: "abc1234def",
      },
      {
        channel: "dev",
        autoEnabled: false,
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: "abc1234def",
          commitsBehind: 246,
        },
      },
    );
    expect(element.element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "246 commits behind",
    );
    expect(
      [...element.element.querySelectorAll(".update-git-revisions code")].map(
        (code) => code.textContent,
      ),
    ).toEqual(["12345678", "abc1234d"]);

    element.setProps({ updateBusy: true });
    await settle();
    const action = element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Updating Gateway…");

    element.setProps({ updateAvailable: null });
    element.setProps({ updateSchedule: null });
    await settle();
    expect(element.element.textContent).toContain("Updating Gateway…");
  });

  it.each(["current", "ahead"] as const)(
    "retires stale git availability after a refreshed %s comparison",
    async (status) => {
      const element = await mount(
        {
          currentVersion: "2026.9.2",
          latestVersion: "2026.9.3",
          channel: "dev",
          commitsBehind: 246,
        },
        {
          channel: "dev",
          autoEnabled: false,
          install: {
            kind: "git",
            git: status === "current" ? { status } : { status, commitsAhead: 1 },
          },
          target: {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "abc1234def",
            commitsBehind: 246,
          },
        },
      );

      expect(element.element.querySelector(".sidebar-update-card")).toBeNull();
    },
  );

  it("retains cached git availability when the refreshed comparison is unavailable", async () => {
    const element = await mount(
      {
        currentVersion: "2026.9.3",
        latestVersion: "2026.9.3",
        channel: "dev",
        commitsBehind: 246,
      },
      {
        channel: "dev",
        autoEnabled: false,
        install: { kind: "git", git: { status: "unavailable", reason: "fetch-failed" } },
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: "abc1234def",
          commitsBehind: 246,
        },
      },
    );

    expect(element.element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "246 commits behind",
    );
  });

  it("keeps an available update actionable inside the compact Inbox row", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.setProps({ compact: true });
    element.setProps({ onDismiss: vi.fn() });
    element.setProps({ onUpdate: vi.fn() });
    await settle();

    expect(element.element.querySelector(".sidebar-issues-panel__entity")?.textContent).toBe(
      "Update available",
    );
    expect(element.element.querySelector("summary time")).toBeNull();
    expect(element.element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "Update Gateway",
    );
    const dismiss = element.element.querySelector<HTMLButtonElement>(
      ".sidebar-issues-panel__dismiss",
    )!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss Update available");
    expect(dismiss.querySelector("svg")).not.toBeNull();
    dismiss.click();
    expect(element.props().onDismiss).toHaveBeenCalledOnce();
    expect(element.props().onUpdate).not.toHaveBeenCalled();
    expect(element.element.querySelector("details")?.open).toBe(false);
  });

  it.each([
    { state: "running", ageMinutes: 30 },
    { state: "succeeded", ageMinutes: 5 },
    { state: "failed", ageMinutes: 5 },
    { state: "campaign", ageMinutes: 20 },
  ] as const)(
    "shows the recorded $state age beside the compact row's detail",
    async ({ state, ageMinutes }) => {
      const now = Date.parse("2026-09-23T12:00:00Z");
      vi.useFakeTimers({ now });
      const element = await mount(null);
      element.setProps({ compact: true });
      if (state === "campaign") {
        element.setProps({
          updateSchedule: {
            channel: "stable",
            autoEnabled: true,
            target: { kind: "package", version: "2026.9.2" },
            campaign: {
              id: "campaign-age",
              state: "countdown",
              announcedAtMs: now - 20 * 60_000,
              updatedAtMs: now - 60_000,
              applyAtMs: now + 10 * 60_000,
              forceAtMs: now + 60 * 60_000,
            },
          },
        });
      } else {
        element.setProps({
          updateRun: createUpdateRunFixture({
            status: state,
            phase: state === "running" ? "staging" : "finished",
            createdAtMs: now - 30 * 60_000,
            updatedAtMs: now - 60_000,
            finishedAtMs: state === "running" ? null : now - 5 * 60_000,
          }),
        });
      }
      await settle();
      await element.element.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-relative-time",
      )?.updateComplete;

      const title = element.element.querySelector("summary .sidebar-issues-panel__entity");
      const meta = title?.nextElementSibling;
      const time = meta?.querySelector("time");
      const timestamp = now - ageMinutes * 60_000;
      expect(meta?.querySelector(".sidebar-issues-panel__state")).not.toBeNull();
      expect(time?.getAttribute("datetime")).toBe(new Date(timestamp).toISOString());
      expect(time?.getAttribute("title")).toBe(formatDateTimeMs(timestamp));
      expect(time?.textContent?.trim()).toBe(`${ageMinutes}m ago`);
      expect(element.element.querySelector("details")?.open).toBe(false);
    },
  );

  it("refreshes a completed update's age without new state and stops ticking on disconnect", async () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    vi.useFakeTimers({ now });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const timersBefore = vi.getTimerCount();
    const element = await mount(null);
    element.setProps({ compact: true });
    element.setProps({
      updateRun: createUpdateRunFixture({
        status: "succeeded",
        phase: "finished",
        createdAtMs: now - 30 * 60_000,
        updatedAtMs: now - 5 * 60_000,
        finishedAtMs: now - 5 * 60_000,
      }),
    });
    await settle();
    await element.element.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-relative-time",
    )?.updateComplete;
    expect(element.element.querySelector("summary time")?.textContent?.trim()).toBe("5m ago");

    await vi.advanceTimersByTimeAsync(60_000);
    const time = element.element.querySelector("summary time");
    expect(time?.textContent?.trim()).toBe("6m ago");

    element.dispose();
    await Promise.resolve();
    expect(element.element.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(timersBefore);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(time?.textContent?.trim()).toBe("6m ago");
  });

  it("keeps an unauthorized update discoverable without allowing activation", async () => {
    const element = await mount(
      {
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: "stable",
      },
      null,
      false,
    );
    const onUpdate = vi.fn();
    element.setProps({ onUpdate });
    await settle();

    const action = element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    const tooltip = action?.closest("openclaw-tooltip") as
      | (HTMLElement & { content?: string; updateComplete: Promise<boolean> })
      | null;
    await tooltip?.updateComplete;

    expect(action?.disabled).toBe(false);
    expect(action?.getAttribute("aria-disabled")).toBe("true");
    expect(action?.getAttribute("aria-describedby")).not.toBeNull();
    expect(tooltip?.hasAttribute("open-on-click")).toBe(true);
    expect(tooltip?.content).toContain("Administrator access is required");
    action?.click();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("renders a quiet live countdown and stops ticking on disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const element = await mount(
      { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "stable" },
      {
        channel: "stable",
        autoEnabled: true,
        target: { kind: "package", version: "2.0.0" },
        campaign: {
          id: "campaign-1",
          state: "countdown",
          announcedAtMs: 0,
          applyAtMs: 55_000,
          forceAtMs: 900_000,
          updatedAtMs: 0,
        },
      },
    );

    const card = element.element.querySelector(".sidebar-update-card");
    const timer = element.element.querySelector("[role='timer']");
    expect(card?.hasAttribute("role")).toBe(false);
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Updating in 0:54 · v2.0.0");
    expect(element.element.querySelector(".sidebar-update-card__hold")?.textContent?.trim()).toBe(
      "Hold 1 h",
    );

    element.setProps({ updateBusy: true });
    await settle();
    expect(element.element.querySelector(".sidebar-update-card__hold")).toBeNull();
    element.setProps({ updateBusy: false });
    await settle();
    expect(element.element.querySelector(".sidebar-update-card__hold")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(element.element.querySelector("[role='timer']")?.textContent).toContain(
      "Updating in 0:53",
    );

    element.dispose();
    expect(clearInterval).toHaveBeenCalled();
  });

  it("keeps a consumed hold hidden across shared-state rerenders after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const element = await mount(
      { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "stable" },
      {
        channel: "stable",
        autoEnabled: true,
        target: { kind: "package", version: "2.0.0" },
        campaign: {
          id: "campaign-1",
          state: "waiting-for-idle",
          announcedAtMs: 0,
          forceAtMs: 900_000,
          updatedAtMs: 0,
        },
      },
    );
    const onHoldUpdate = vi.fn(async () => true);
    element.setProps({ onHoldUpdate });
    await settle();

    element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__hold")?.click();
    await Promise.resolve();
    await settle();

    expect(onHoldUpdate).toHaveBeenCalledOnce();
    element.setProps({ heldUpdateCampaignId: "campaign-1" });
    element.setProps({
      updateSchedule: {
        ...element.props().updateSchedule!,
        campaign: { ...element.props().updateSchedule!.campaign!, holdUntilMs: 61_000 },
      },
    });
    await settle();
    expect(element.element.querySelector(".sidebar-update-card__hold")).toBeNull();

    element.setProps({
      updateSchedule: {
        ...element.props().updateSchedule!,
        campaign: { ...element.props().updateSchedule!.campaign!, holdUntilMs: 500 },
      },
    });
    await settle();
    expect(element.element.querySelector(".sidebar-update-card__hold")).toBeNull();
  });

  it("renders held timing and gates hold for active or unauthorized campaigns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const schedule: UpdateScheduleState = {
      channel: "dev",
      autoEnabled: true,
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "a".repeat(40),
        commitsBehind: 2,
      },
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 0,
        holdUntilMs: 61_000,
        forceAtMs: 961_000,
        updatedAtMs: 1_000,
      },
    };
    const held = await mount(null, schedule);
    expect(held.element.textContent).toContain("Update held · resumes in 1:00");
    expect(held.element.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unheldSchedule: UpdateScheduleState = {
      ...schedule,
      campaign: { ...schedule.campaign!, holdUntilMs: undefined },
    };
    const unauthorized = await mount(null, unheldSchedule, false);
    expect(unauthorized.element.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unsupported = await mount(null, unheldSchedule, true, false);
    expect(unsupported.element.querySelector(".sidebar-update-card__hold")).toBeNull();
  });
});
