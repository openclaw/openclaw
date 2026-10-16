/* @vitest-environment jsdom */

import { render as mountSolid } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT } from "../app/native-link-routing.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
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
    captureUpdateTarget: () => () => true,
    canStartNativeUpdate: (): boolean => props().canNativeUpdate ?? false,
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
  it.each([false, true])(
    "retains admitted native ownership when the bridge disappears before confirmation=%s",
    async (bridgeLost) => {
      const restoreDialog = installDialogPolyfill();
      const postMessage = vi.fn();
      Object.defineProperty(window, "webkit", {
        configurable: true,
        value: { messageHandlers: { openclawUpdate: { postMessage } } },
      });
      const check = createDeferred<boolean>();
      const update: UpdateAvailable = {
        channel: "dev",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        currentSha: "a".repeat(40),
        upstreamSha: "b".repeat(40),
        upstreamRef: "origin/main",
        commitsBehind: 7,
      };
      const fresh = { ...update, upstreamSha: "c".repeat(40), commitsBehind: 9 };
      const element = await mount(update);
      element.setProps({ canNativeUpdate: true });
      element.setProps({ compact: true });
      element.setProps({ onUpdate: vi.fn() });
      element.setProps({ onCheckStatus: vi.fn(async () => false) });
      element.setProps({
        prepareRetry: vi.fn(async () =>
          (await check.promise) ? { updateAvailable: fresh, updateSchedule: null } : null,
        ),
      });
      await settle();
      try {
        element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
        // Remove the bridge in the same turn, before any preflight promise continuation.
        if (bridgeLost) {
          Reflect.deleteProperty(window, "webkit");
        }
        await vi.dynamicImportSettled();
        const { modal } = await getRenderedModalDialog(document.body);
        const nativeConfirm = [...modal.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Update Mac app and restart",
        );
        expect(nativeConfirm).toBeDefined();
        expect(element.props().onCheckStatus).not.toHaveBeenCalled();
        nativeConfirm!.click();
        if (bridgeLost) {
          await vi.waitFor(() => expect(element.props().prepareRetry).toHaveBeenCalledOnce());
          expect(element.props().onUpdate).not.toHaveBeenCalled();
          check.resolve(true);
          await vi.dynamicImportSettled();
          const refreshed = await getRenderedModalDialog(document.body);
          expect(refreshed.modal.textContent).toContain("cccccccc");
          expect(refreshed.modal.textContent).toContain("9 commits behind");
          expect(refreshed.modal.textContent).not.toContain("bbbbbbbb");
          expect(element.props().onUpdate).not.toHaveBeenCalled();
          const gatewayConfirm = [...refreshed.modal.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Update and restart",
          );
          expect(gatewayConfirm).toBeDefined();
          gatewayConfirm!.click();
          await vi.waitFor(() => expect(element.props().onUpdate).toHaveBeenCalledOnce());
          expect(postMessage).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
          expect(element.props().prepareRetry).not.toHaveBeenCalled();
          expect(element.props().onUpdate).not.toHaveBeenCalled();
        }
      } finally {
        check.resolve(false);
        await vi.dynamicImportSettled();
        document.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
        restoreDialog();
      }
    },
  );
  it.each([false, true])(
    "rechecks the target before retrying a failed run with successful discovery=%s",
    async (successful) => {
      const restoreDialog = installDialogPolyfill();
      const check = createDeferred<boolean>();
      const update: UpdateAvailable = {
        channel: "dev",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        currentSha: "a".repeat(40),
        upstreamSha: "b".repeat(40),
        upstreamRef: "origin/main",
        commitsBehind: 7,
      };
      const element = await mount(update);
      element.setProps({
        updateRun: createUpdateRunFixture({
          status: "failed",
          phase: "finished",
          reason: "build-failed",
          updatedAtMs: Date.now(),
          finishedAtMs: Date.now(),
        }),
      });
      element.setProps({ compact: true });
      element.setProps({ onUpdate: vi.fn() });
      element.setProps({
        prepareRetry: vi.fn(async () =>
          (await check.promise)
            ? {
                updateAvailable: element.props().updateAvailable ?? null,
                updateSchedule: element.props().updateSchedule ?? null,
              }
            : null,
        ),
      });
      await settle();
      try {
        element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
        await vi.dynamicImportSettled();
        const { modal } = await getRenderedModalDialog(document.body);
        const retry = [...modal.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Retry update",
        );
        expect(retry).toBeDefined();
        retry!.click();
        await vi.waitFor(() => expect(element.props().prepareRetry).toHaveBeenCalledOnce());
        expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull();
        expect(element.props().onUpdate).not.toHaveBeenCalled();

        element.setProps({
          updateAvailable: { ...update, upstreamSha: "c".repeat(40), commitsBehind: 9 },
        });
        await settle();
        check.resolve(successful);
        await vi.dynamicImportSettled();
        await settle();
        if (successful) {
          const fresh = await getRenderedModalDialog(document.body);
          expect(fresh.modal.textContent).toContain("9 commits behind");
          expect(fresh.modal.textContent).toContain("cccccccc");
          expect(fresh.modal.textContent).not.toContain("bbbbbbbb");
        } else {
          expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull();
          expect(document.querySelector("openclaw-modal-dialog")?.textContent).toContain(
            "Status could not be refreshed. Check your connection and try again.",
          );
          element.setProps({
            statusBanner: {
              tone: "warn",
              source: "read",
              text: "Latest target unavailable.",
            },
          });
          await settle();
          expect(element.element.querySelector('[role="alert"]')?.textContent).toContain(
            "Latest target unavailable.",
          );
          expect(element.element.querySelector("summary")?.textContent).toContain(
            "Latest target unavailable.",
          );
        }
        expect(element.props().onUpdate).not.toHaveBeenCalled();
      } finally {
        check.resolve(false);
        await vi.dynamicImportSettled();
        document.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
        restoreDialog();
      }
    },
  );

  it("keeps native ownership separate from Gateway freshness and follows bridge availability", async () => {
    const element = await mount(
      { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "stable" },
      null,
      false,
    );
    element.setProps({ canNativeUpdate: true });
    element.setProps({ compact: true });
    element.setProps({ onCheckStatus: vi.fn(async () => false) });
    await settle();
    const action = () =>
      element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!;
    expect(action().getAttribute("aria-disabled")).toBe("true");

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage: vi.fn() } } },
    });
    window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await settle();
    expect(action().hasAttribute("aria-disabled")).toBe(false);
    expect(action().textContent).toContain("Update Mac app");
    const details = element.element.querySelector("details")!;
    const expanded = new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    await expanded;
    await settle();
    expect(element.props().onCheckStatus).not.toHaveBeenCalled();

    element.setProps({ canNativeUpdate: false });
    await settle();
    expect(action().getAttribute("aria-disabled")).toBe("true");
    element.setProps({ canNativeUpdate: true });
    Reflect.deleteProperty(window, "webkit");
    window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await settle();
    expect(action().getAttribute("aria-disabled")).toBe("true");
  });

  it("checks and replaces the target on every expansion with acknowledged history", async () => {
    const update: UpdateAvailable = {
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      channel: "dev",
      currentSha: "a".repeat(40),
      upstreamSha: "b".repeat(40),
      upstreamRef: "origin/main",
      commitsBehind: 7,
    };
    const element = await mount(update);
    element.setProps({
      updateRun: createUpdateRunFixture({ status: "succeeded", phase: "finished" }),
      updateRunAcknowledged: true,
    });
    const check = createDeferred<boolean>();
    element.setProps({ compact: true });
    element.setProps({ onCheckStatus: vi.fn(() => check.promise) });
    element.setProps({ onUpdate: vi.fn() });
    await settle();
    const details = element.element.querySelector("details")!;
    details.open = true;
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledOnce());
    await settle();
    expect(element.element.textContent).toContain("Checking for updates…");
    expect(element.element.querySelector(".update-git-revisions")).toBeNull();
    expect(
      element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.disabled,
    ).toBe(true);

    element.setProps({
      updateAvailable: { ...update, upstreamSha: "c".repeat(40), commitsBehind: 9 },
    });
    await settle();
    check.resolve(true);
    await vi.waitFor(() =>
      expect(element.element.querySelector(".update-git-revisions")?.textContent).toContain(
        "cccccccc",
      ),
    );
    expect(element.element.textContent).toContain("9 commits behind");
    expect(element.props().onUpdate).not.toHaveBeenCalled();
    details.open = false;
    await new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledTimes(2));
  });

  it("retries a failed fresh target check in the compact row", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.setProps({ compact: true });
    await settle();
    element.setProps({ onCheckStatus: vi.fn(async () => false) });
    element.setProps({ onUpdate: vi.fn() });
    await settle();
    element.element.querySelector("details")!.open = true;
    await vi.waitFor(() =>
      expect(element.element.textContent).toContain("Could not check the latest update"),
    );
    const action = element.element.querySelector<HTMLButtonElement>(
      ".sidebar-update-card__action",
    )!;
    await vi.waitFor(() => expect(action.disabled).toBe(false));
    action.click();
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(action.disabled).toBe(false));
    expect(element.element.textContent).toContain("Could not check the latest update");
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(element.props().onUpdate).not.toHaveBeenCalled();
    // A later status read can clear the unavailable target without clearing its error.
    element.setProps({ updateAvailable: null });
    element.setProps({
      updateRun: createUpdateRunFixture({ status: "succeeded", phase: "finished" }),
    });
    element.setProps({ updateRunAcknowledged: true });
    element.setProps({
      statusBanner: {
        tone: "warn",
        source: "read",
        text: "Could not check the latest update",
      },
    });
    await settle();
    const retry = [...element.element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry now"),
    );
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledTimes(3));
    expect(element.props().onUpdate).not.toHaveBeenCalled();
  });

  it("keeps the compact action busy from expansion until its target check settles", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const check = createDeferred<boolean>();
    element.setProps({ compact: true, onCheckStatus: vi.fn(() => check.promise) });
    await settle();
    const action = () =>
      element.element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!;
    const details = element.element.querySelector("details")!;
    const expanded = new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    // The toggle that starts the check is queued after opening; a press here must not land.
    expect(element.props().onCheckStatus).not.toHaveBeenCalled();
    expect(action().disabled).toBe(true);
    expect(action().getAttribute("aria-busy")).toBe("true");

    await expanded;
    await settle();
    expect(element.props().onCheckStatus).toHaveBeenCalledOnce();
    expect(action().disabled).toBe(true);
    check.resolve(true);
    await vi.waitFor(() => expect(action().disabled).toBe(false));
    expect(action().getAttribute("aria-busy")).toBe("false");
    expect(action().textContent).toContain("Update Gateway");
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
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(2);

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
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(3);
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

      const completedRun = createUpdateRunFixture({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: Date.now(),
        after: { version: "2026.9.2" },
      });
      element.setProps({ updateRun: completedRun });
      await settle();
      expect(element.element.textContent).toContain("OpenClaw updated to 2026.9.2");
      element.setProps({ updateRunAcknowledged: true });
      await settle();
      expect(element.element.querySelector(".sidebar-update-card")).toBeNull();
      element.setProps({ updateRunAcknowledged: false });
      element.setProps({
        updateRun: { ...completedRun, finishedAtMs: Date.now() - 24 * 60 * 60 * 1000 },
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

  it.each(["current"] as const)(
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
            git: { status },
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
