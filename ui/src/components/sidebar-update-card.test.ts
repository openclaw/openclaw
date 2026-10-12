/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT } from "../app/native-link-routing.ts";
import type { ConfirmAndStartUpdateParams } from "../app/update-confirmation.ts";
import type { ApplicationStatusBanner } from "../app/update-overlay-helpers.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import "./sidebar-update-card.ts";

type SidebarUpdateCardElement = HTMLElement & {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  compact: boolean;
  heldUpdateCampaignId: string | null;
  updateBusy: boolean;
  updateRun: UpdateRunRecord | null;
  updateRunAcknowledged: boolean;
  canUpdate: boolean;
  canNativeUpdate: boolean;
  canHoldUpdate: boolean;
  onUpdate: () => void;
  onCheckStatus?: () => Promise<boolean>;
  prepareRetry?: ConfirmAndStartUpdateParams["prepareRetry"];
  onDismiss?: () => void;
  refreshRequired: boolean;
  onRefresh: () => Promise<boolean>;
  onHoldUpdate: () => Promise<boolean>;
  statusBanner: ApplicationStatusBanner | null;
  onReviewUpdate: () => void;
  updateComplete: Promise<boolean>;
};

let originalWebkit: PropertyDescriptor | undefined;

async function mount(
  update: UpdateAvailable | null,
  schedule: UpdateScheduleState | null = null,
  canUpdate = true,
  canHoldUpdate = true,
) {
  const element = document.createElement(
    "openclaw-sidebar-update-card",
  ) as SidebarUpdateCardElement;
  element.updateAvailable = update;
  element.updateSchedule = schedule;
  element.canUpdate = canUpdate;
  element.canHoldUpdate = canHoldUpdate;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

beforeEach(() => {
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(async () => {
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
      element.canNativeUpdate = true;
      element.compact = true;
      element.onUpdate = vi.fn();
      element.onCheckStatus = vi.fn(async () => false);
      element.prepareRetry = vi.fn(async () =>
        (await check.promise) ? { updateAvailable: fresh, updateSchedule: null } : null,
      );
      await element.updateComplete;
      try {
        element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
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
        expect(element.onCheckStatus).not.toHaveBeenCalled();
        nativeConfirm!.click();
        if (bridgeLost) {
          await vi.waitFor(() => expect(element.prepareRetry).toHaveBeenCalledOnce());
          expect(element.onUpdate).not.toHaveBeenCalled();
          check.resolve(true);
          await vi.dynamicImportSettled();
          const refreshed = await getRenderedModalDialog(document.body);
          expect(refreshed.modal.textContent).toContain("cccccccc");
          expect(refreshed.modal.textContent).toContain("9 commits behind");
          expect(refreshed.modal.textContent).not.toContain("bbbbbbbb");
          expect(element.onUpdate).not.toHaveBeenCalled();
          const gatewayConfirm = [...refreshed.modal.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Update and restart",
          );
          expect(gatewayConfirm).toBeDefined();
          gatewayConfirm!.click();
          await vi.waitFor(() => expect(element.onUpdate).toHaveBeenCalledOnce());
          expect(postMessage).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
          expect(element.prepareRetry).not.toHaveBeenCalled();
          expect(element.onUpdate).not.toHaveBeenCalled();
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
      element.updateRun = createUpdateRunFixture({
        status: "failed",
        phase: "finished",
        reason: "build-failed",
        updatedAtMs: Date.now(),
        finishedAtMs: Date.now(),
      });
      element.compact = true;
      element.onUpdate = vi.fn();
      element.prepareRetry = vi.fn(async () =>
        (await check.promise)
          ? { updateAvailable: element.updateAvailable, updateSchedule: element.updateSchedule }
          : null,
      );
      await element.updateComplete;
      try {
        element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
        await vi.dynamicImportSettled();
        const { modal } = await getRenderedModalDialog(document.body);
        const retry = [...modal.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Retry update",
        );
        expect(retry).toBeDefined();
        retry!.click();
        await vi.waitFor(() => expect(element.prepareRetry).toHaveBeenCalledOnce());
        expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull();
        expect(element.onUpdate).not.toHaveBeenCalled();

        element.updateAvailable = { ...update, upstreamSha: "c".repeat(40), commitsBehind: 9 };
        check.resolve(successful);
        await vi.dynamicImportSettled();
        await element.updateComplete;
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
          element.statusBanner = {
            tone: "warn",
            source: "read",
            text: "Latest target unavailable.",
          };
          await element.updateComplete;
          expect(element.querySelector('[role="alert"]')?.textContent).toContain(
            "Latest target unavailable.",
          );
          expect(element.querySelector("summary")?.textContent).toContain(
            "Latest target unavailable.",
          );
        }
        expect(element.onUpdate).not.toHaveBeenCalled();
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
    element.canNativeUpdate = true;
    element.compact = true;
    element.onCheckStatus = vi.fn(async () => false);
    await element.updateComplete;
    const action = () => element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!;
    expect(action().getAttribute("aria-disabled")).toBe("true");

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage: vi.fn() } } },
    });
    window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(action().hasAttribute("aria-disabled")).toBe(false);
    expect(action().textContent).toContain("Update Mac app");
    const details = element.querySelector("details")!;
    const expanded = new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    await expanded;
    await element.updateComplete;
    expect(element.onCheckStatus).not.toHaveBeenCalled();

    element.canNativeUpdate = false;
    await element.updateComplete;
    expect(action().getAttribute("aria-disabled")).toBe("true");
    element.canNativeUpdate = true;
    Reflect.deleteProperty(window, "webkit");
    window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
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
    element.updateRun = createUpdateRunFixture({ status: "succeeded", phase: "finished" });
    element.updateRunAcknowledged = true;
    const check = createDeferred<boolean>();
    element.compact = true;
    element.onCheckStatus = vi.fn(() => check.promise);
    element.onUpdate = vi.fn();
    await element.updateComplete;
    const details = element.querySelector("details")!;
    details.open = true;
    await vi.waitFor(() => expect(element.onCheckStatus).toHaveBeenCalledOnce());
    await element.updateComplete;
    expect(element.textContent).toContain("Checking for updates…");
    expect(element.querySelector(".update-git-revisions")).toBeNull();
    expect(element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.disabled).toBe(
      true,
    );

    element.updateAvailable = { ...update, upstreamSha: "c".repeat(40), commitsBehind: 9 };
    check.resolve(true);
    await vi.waitFor(() =>
      expect(element.querySelector(".update-git-revisions")?.textContent).toContain("cccccccc"),
    );
    expect(element.textContent).toContain("9 commits behind");
    expect(element.onUpdate).not.toHaveBeenCalled();
    details.open = false;
    await new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    await vi.waitFor(() => expect(element.onCheckStatus).toHaveBeenCalledTimes(2));
  });

  it("checks and retries the target when running updates is unavailable", async () => {
    const element = await mount(
      { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "stable" },
      null,
      false,
    );
    element.compact = true;
    element.onCheckStatus = vi.fn(async () => false);
    element.onUpdate = vi.fn();
    await element.updateComplete;
    element.querySelector("details")!.open = true;
    await vi.waitFor(() => expect(element.onCheckStatus).toHaveBeenCalledOnce());
    element.updateAvailable = null;
    element.statusBanner = {
      tone: "warn",
      source: "read",
      text: "Could not check the latest update",
    };
    await element.updateComplete;
    const retry = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry now"),
    );
    expect(retry?.disabled).toBe(false);
    retry!.click();
    await vi.waitFor(() => expect(element.onCheckStatus).toHaveBeenCalledTimes(2));
    element.updateAvailable = {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    };
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
    expect(element.onUpdate).not.toHaveBeenCalled();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("retries a failed fresh target check in the compact row", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.compact = true;
    await element.updateComplete;
    element.onCheckStatus = vi.fn(async () => false);
    element.onUpdate = vi.fn();
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain("Could not check the latest update"),
    );
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(element.onUpdate).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.disabled).toBe(
      false,
    );
    // A later status read can clear the unavailable target without clearing its error.
    element.updateAvailable = null;
    element.updateRun = createUpdateRunFixture({ status: "succeeded", phase: "finished" });
    element.updateRunAcknowledged = true;
    element.statusBanner = {
      tone: "warn",
      source: "read",
      text: "Could not check the latest update",
    };
    await element.updateComplete;
    const retry = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry now"),
    );
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => expect(element.onCheckStatus).toHaveBeenCalledTimes(2));
    expect(element.onUpdate).not.toHaveBeenCalled();
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
    element.refreshRequired = true;
    element.onRefresh = onRefresh;
    await element.updateComplete;

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    await element.updateComplete;

    element.refreshRequired = false;
    await element.updateComplete;
    element.refreshRequired = true;
    await element.updateComplete;
    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    action?.click();
    await element.updateComplete;
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(action?.disabled).toBe(true);
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(2);

    completeFirst?.(false);
    await element.updateComplete;
    expect(action?.disabled).toBe(true);
    expect(element.textContent).not.toContain(
      "Actions are unavailable while the Gateway reconnects.",
    );

    completeSecond?.(false);
    await vi.waitFor(() => expect(action?.disabled).toBe(false));
    expect(element.textContent).toContain("Actions are unavailable while the Gateway reconnects.");
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

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
    expect(element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "246 commits behind",
    );
    expect(
      [...element.querySelectorAll(".update-git-revisions code")].map((code) => code.textContent),
    ).toEqual(["12345678", "abc1234d"]);

    element.updateBusy = true;
    await element.updateComplete;
    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Updating Gateway…");

    element.updateAvailable = null;
    element.updateSchedule = null;
    await element.updateComplete;
    expect(element.textContent).toContain("Updating Gateway…");
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

      expect(element.querySelector(".sidebar-update-card")).toBeNull();
    },
  );

  it("keeps an available update actionable inside the compact Inbox row", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.compact = true;
    element.onDismiss = vi.fn();
    element.onUpdate = vi.fn();
    await element.updateComplete;

    expect(element.querySelector(".sidebar-issues-panel__entity")?.textContent).toBe(
      "Update available",
    );
    expect(element.querySelector("summary time")).toBeNull();
    expect(element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "Update Gateway",
    );
    const dismiss = element.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss Update available");
    expect(dismiss.querySelector("svg")).not.toBeNull();
    dismiss.click();
    expect(element.onDismiss).toHaveBeenCalledOnce();
    expect(element.onUpdate).not.toHaveBeenCalled();
    expect(element.querySelector("details")?.open).toBe(false);
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
      element.compact = true;
      if (state === "campaign") {
        element.updateSchedule = {
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
        };
      } else {
        element.updateRun = createUpdateRunFixture({
          status: state,
          phase: state === "running" ? "staging" : "finished",
          createdAtMs: now - 30 * 60_000,
          updatedAtMs: now - 60_000,
          finishedAtMs: state === "running" ? null : now - 5 * 60_000,
        });
      }
      await element.updateComplete;
      await element.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-relative-time",
      )?.updateComplete;

      const title = element.querySelector("summary .sidebar-issues-panel__entity");
      const meta = title?.nextElementSibling;
      const time = meta?.querySelector("time");
      const timestamp = now - ageMinutes * 60_000;
      expect(meta?.querySelector(".sidebar-issues-panel__state")).not.toBeNull();
      expect(time?.getAttribute("datetime")).toBe(new Date(timestamp).toISOString());
      expect(time?.getAttribute("title")).toBe(formatDateTimeMs(timestamp));
      expect(time?.textContent?.trim()).toBe(`${ageMinutes}m ago`);
      expect(element.querySelector("details")?.open).toBe(false);
    },
  );

  it("refreshes a completed update's age without new state and stops ticking on disconnect", async () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    vi.useFakeTimers({ now });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const timersBefore = vi.getTimerCount();
    const element = await mount(null);
    element.compact = true;
    element.updateRun = createUpdateRunFixture({
      status: "succeeded",
      phase: "finished",
      createdAtMs: now - 30 * 60_000,
      updatedAtMs: now - 5 * 60_000,
      finishedAtMs: now - 5 * 60_000,
    });
    await element.updateComplete;
    await element.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-relative-time",
    )?.updateComplete;
    expect(element.querySelector("summary time")?.textContent?.trim()).toBe("5m ago");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(element.querySelector("summary time")?.textContent?.trim()).toBe("6m ago");

    element.remove();
    await Promise.resolve();
    expect(element.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(timersBefore);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(timersBefore);
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
    element.onUpdate = onUpdate;

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
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

    const card = element.querySelector(".sidebar-update-card");
    const timer = element.querySelector("[role='timer']");
    expect(card?.hasAttribute("role")).toBe(false);
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Updating in 0:54 · v2.0.0");
    expect(element.querySelector(".sidebar-update-card__hold")?.textContent?.trim()).toBe(
      "Hold 1 h",
    );

    element.updateBusy = true;
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();
    element.updateBusy = false;
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await element.updateComplete;
    expect(element.querySelector("[role='timer']")?.textContent).toContain("Updating in 0:53");

    element.remove();
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
    element.onHoldUpdate = onHoldUpdate;

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__hold")?.click();
    await Promise.resolve();
    await element.updateComplete;

    expect(onHoldUpdate).toHaveBeenCalledOnce();
    element.heldUpdateCampaignId = "campaign-1";
    element.updateSchedule = {
      ...element.updateSchedule!,
      campaign: { ...element.updateSchedule!.campaign!, holdUntilMs: 61_000 },
    };
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();

    element.updateSchedule = {
      ...element.updateSchedule!,
      campaign: { ...element.updateSchedule!.campaign!, holdUntilMs: 500 },
    };
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();
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
    expect(held.textContent).toContain("Update held · resumes in 1:00");
    expect(held.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unheldSchedule: UpdateScheduleState = {
      ...schedule,
      campaign: { ...schedule.campaign!, holdUntilMs: undefined },
    };
    const unauthorized = await mount(null, unheldSchedule, false);
    expect(unauthorized.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unsupported = await mount(null, unheldSchedule, true, false);
    expect(unsupported.querySelector(".sidebar-update-card__hold")).toBeNull();
  });
});
