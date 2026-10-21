/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT } from "../app/native-link-routing.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { SidebarUpdateCard, type SidebarUpdateCardProps } from "./sidebar-update-card.tsx";

let originalWebkit: PropertyDescriptor | undefined;
const checkFailure = "Could not check the latest update";
const reconnectFailure = "Could not refresh. Check your connection and try again.";
async function settle() {
  await Promise.resolve();
  flush();
}
const stableUpdate: UpdateAvailable = {
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
  channel: "stable",
};
const gitUpdate: UpdateAvailable = {
  ...stableUpdate,
  latestVersion: "1.0.0",
  channel: "dev",
  currentSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  upstreamRef: "origin/main",
  commitsBehind: 7,
};
const freshGitUpdate = { ...gitUpdate, upstreamSha: "c".repeat(40), commitsBehind: 9 };
const gitSchedule: UpdateScheduleState = {
  channel: "dev",
  autoEnabled: false,
  target: {
    kind: "git",
    upstreamRef: "origin/main",
    upstreamSha: "abc1234def",
    commitsBehind: 246,
  },
};
function packageSchedule(
  campaign: Partial<NonNullable<UpdateScheduleState["campaign"]>>,
  version = "2.0.0",
): UpdateScheduleState {
  return {
    channel: "stable",
    autoEnabled: true,
    target: { kind: "package", version },
    campaign: {
      id: "campaign-1",
      state: "waiting-for-idle",
      announcedAtMs: 0,
      forceAtMs: 900_000,
      updatedAtMs: 0,
      ...campaign,
    },
  };
}
function succeededRun(patch: Parameters<typeof createUpdateRunFixture>[0] = {}) {
  return createUpdateRunFixture({ status: "succeeded", phase: "finished", ...patch });
}
function installNativeBridge(postMessage = vi.fn()) {
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { openclawUpdate: { postMessage } } },
  });
  return postMessage;
}
function modalButton(modal: Element, label: string) {
  const match = [...modal.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  expect(match).toBeDefined();
  return match!;
}
async function mount(
  update: UpdateAvailable | null = null,
  initial: Partial<SidebarUpdateCardProps> = {},
) {
  const [props, set] = createSignal<Partial<SidebarUpdateCardProps>>({
    updateAvailable: update,
    canUpdate: true,
    canHoldUpdate: true,
    captureUpdateTarget: () => () => true,
    canStartNativeUpdate: (): boolean => props().canNativeUpdate ?? false,
    ...initial,
  });
  const { container: element, unmount: dispose } = mountSolid(() => (
    <SidebarUpdateCard {...props()} />
  ));
  await settle();
  const find = element.querySelector.bind(element);
  const setProps = (value: Partial<SidebarUpdateCardProps>) =>
    set((previous) => ({ ...previous, ...value }));
  return {
    element,
    text: () => element.textContent,
    find,
    props,
    setProps,
    dispose,
    action: () => find<HTMLButtonElement>(".sidebar-update-card__action"),
    expand(open = true) {
      const details = find("details")!;
      const expanded = new Promise<void>((resolve) => {
        details.addEventListener("toggle", () => resolve(), { once: true });
      });
      details.open = open;
      return expanded.then(settle);
    },
    async update(value: Partial<SidebarUpdateCardProps>) {
      setProps(value);
      await settle();
    },
  };
}

beforeEach(() => {
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(async () => {
  cleanupSolid();
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
  it("reviews updates through the latest callback on the retained card", async () => {
    const initial = vi.fn();
    const current = vi.fn();
    const card = await mount(stableUpdate, {
      statusBanner: { tone: "warn", text: "Review available update" },
      onReviewUpdate: initial,
    });
    const review = card.find<HTMLButtonElement>(".sidebar-update-card__review")!;
    await card.update({ onReviewUpdate: current });
    review.click();
    expect(current).toHaveBeenCalledOnce();
    expect(initial).not.toHaveBeenCalled();
    expect(card.find(".sidebar-update-card__review")).toBe(review);
  });

  it.each([
    ["native", false],
    ["native", true],
    ["retry", false],
    ["retry", true],
  ] as const)("revalidates %s confirmation (variant: %s)", async (mode, variant) => {
    const native = mode === "native";
    const bridgeLost = native && variant;
    const successful = native || variant;
    const restoreDialog = installDialogPolyfill();
    const postMessage = native ? installNativeBridge() : vi.fn();
    const check = createDeferred<boolean>();
    const element = await mount(gitUpdate);
    await element.update({
      compact: true,
      canNativeUpdate: native,
      onUpdate: vi.fn(),
      onCheckStatus: native ? vi.fn(async () => false) : undefined,
      updateRun: native
        ? null
        : createUpdateRunFixture({
            status: "failed",
            phase: "finished",
            reason: "build-failed",
            updatedAtMs: Date.now(),
            finishedAtMs: Date.now(),
          }),
      prepareRetry: vi.fn(async () =>
        (await check.promise)
          ? {
              updateAvailable: native ? freshGitUpdate : (element.props().updateAvailable ?? null),
              updateSchedule: native ? null : (element.props().updateSchedule ?? null),
            }
          : null,
      ),
    });
    try {
      element.action()!.click();
      // Bridge loss must happen before the preflight promise continues.
      if (bridgeLost) {
        Reflect.deleteProperty(window, "webkit");
      }
      await vi.dynamicImportSettled();
      const { modal } = await getRenderedModalDialog(document.body);
      if (native) {
        expect(element.props().onCheckStatus).not.toHaveBeenCalled();
      }
      modalButton(modal, native ? "Update Mac app and restart" : "Retry update").click();
      if (native && !bridgeLost) {
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
        expect(element.props().prepareRetry).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(element.props().prepareRetry).toHaveBeenCalledOnce());
        expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull();
        expect(element.props().onUpdate).not.toHaveBeenCalled();
        if (!native) {
          await element.update({ updateAvailable: freshGitUpdate });
        }
        check.resolve(successful);
        await vi.dynamicImportSettled();
        if (!native) {
          await settle();
        }
        if (successful) {
          const refreshed = await getRenderedModalDialog(document.body);
          expect(refreshed.modal.textContent).toContain("cccccccc");
          expect(refreshed.modal.textContent).toContain("9 commits behind");
          expect(refreshed.modal.textContent).not.toContain("bbbbbbbb");
          expect(element.props().onUpdate).not.toHaveBeenCalled();
          if (bridgeLost) {
            modalButton(refreshed.modal, "Update and restart").click();
            await vi.waitFor(() => expect(element.props().onUpdate).toHaveBeenCalledOnce());
            expect(postMessage).not.toHaveBeenCalled();
          }
        } else {
          const failedModal = document.querySelector("openclaw-modal-dialog");
          expect(failedModal).not.toBeNull();
          expect(failedModal?.textContent).toContain(
            "Status could not be refreshed. Check your connection and try again.",
          );
          await element.update({
            statusBanner: {
              tone: "warn",
              source: "read",
              text: "Latest target unavailable.",
            },
          });
          for (const selector of ['[role="alert"]', "summary"]) {
            expect(element.find(selector)?.textContent).toContain("Latest target unavailable.");
          }
        }
      }
      if (!bridgeLost) {
        expect(element.props().onUpdate).not.toHaveBeenCalled();
      }
    } finally {
      check.resolve(false);
      await vi.dynamicImportSettled();
      document.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
      restoreDialog();
    }
  });

  it("keeps native ownership separate from Gateway freshness and follows bridge availability", async () => {
    const element = await mount(stableUpdate, {
      canUpdate: false,
      canNativeUpdate: true,
      compact: true,
      onCheckStatus: vi.fn(async () => false),
    });
    const action = () => element.action()!;
    expect(action().getAttribute("aria-disabled")).toBe("true");

    installNativeBridge();
    window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await settle();
    expect(action().hasAttribute("aria-disabled")).toBe(false);
    expect(action().textContent).toContain("Update Mac app");
    await element.expand();
    expect(element.props().onCheckStatus).not.toHaveBeenCalled();

    await element.update({ canNativeUpdate: false });
    expect(action().getAttribute("aria-disabled")).toBe("true");
    element.setProps({ canNativeUpdate: true });
    Reflect.deleteProperty(window, "webkit");
    window.dispatchEvent(new Event(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await settle();
    expect(action().getAttribute("aria-disabled")).toBe("true");
  });

  it.each(["history", "busy"] as const)(
    "checks expansion before enabling a %s action",
    async (mode) => {
      const history = mode === "history";
      const check = createDeferred<boolean>();
      const element = await mount(history ? gitUpdate : stableUpdate, {
        compact: true,
        onCheckStatus: vi.fn(() => check.promise),
        onUpdate: vi.fn(),
        updateRun: history ? succeededRun() : undefined,
        updateRunAcknowledged: history,
      });
      const details = element.find("details")!;
      const expanded = element.expand();
      if (!history) {
        // A click before the queued toggle starts discovery must not activate.
        expect(element.props().onCheckStatus).not.toHaveBeenCalled();
        expect(element.action()?.disabled).toBe(true);
        expect(element.action()?.getAttribute("aria-busy")).toBe("true");
      }
      await expanded;
      expect(element.props().onCheckStatus).toHaveBeenCalledOnce();
      expect(element.action()?.disabled).toBe(true);
      if (history) {
        expect(element.element.textContent).toContain("Checking for updates…");
        expect(element.find(".update-git-revisions")).toBeNull();
        await element.update({ updateAvailable: freshGitUpdate });
      }
      check.resolve(true);
      if (history) {
        await vi.waitFor(() =>
          expect(element.find(".update-git-revisions")?.textContent).toContain("cccccccc"),
        );
        expect(element.element.textContent).toContain("9 commits behind");
        expect(element.props().onUpdate).not.toHaveBeenCalled();
        await element.expand(false);
        details.open = true;
        await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledTimes(2));
      } else {
        await vi.waitFor(() => expect(element.action()?.disabled).toBe(false));
        expect(element.action()?.getAttribute("aria-busy")).toBe("false");
        expect(element.action()?.textContent).toContain("Update Gateway");
      }
    },
  );

  it("retries a failed fresh target check in the compact row", async () => {
    const check = createDeferred<boolean>();
    const element = await mount(stableUpdate, {
      compact: true,
      onCheckStatus: vi.fn().mockReturnValueOnce(check.promise).mockResolvedValue(false),
      onUpdate: vi.fn(),
    });
    element.find("details")!.open = true;
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledOnce());
    expect(element.action()?.disabled).toBe(true);
    expect(element.action()?.getAttribute("aria-busy")).toBe("true");
    check.reject(new Error("Status unavailable"));
    await vi.waitFor(() => expect(element.text()).toContain(checkFailure));
    const action = element.action()!;
    await vi.waitFor(() => expect(action.disabled).toBe(false));
    action.click();
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(action.disabled).toBe(false));
    expect(element.text()).toContain(checkFailure);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(element.props().onUpdate).not.toHaveBeenCalled();
    // A later status read can clear the unavailable target without clearing its error.
    await element.update({
      updateAvailable: null,
      updateRun: succeededRun(),
      updateRunAcknowledged: true,
      statusBanner: {
        tone: "warn",
        source: "read",
        text: checkFailure,
      },
    });
    const retry = [...element.element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry now"),
    );
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => expect(element.props().onCheckStatus).toHaveBeenCalledTimes(3));
    expect(element.props().onUpdate).not.toHaveBeenCalled();
  });

  it("retains refresh retries across shell updates and ignores obsolete recovery results", async () => {
    const element = await mount(null);
    const first = createDeferred<boolean>();
    const second = createDeferred<boolean>();
    const onRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await element.update({ refreshRequired: true, onRefresh });

    element.action()?.click();
    await settle();

    await element.update({ refreshRequired: false });
    await element.update({ refreshRequired: true });
    const action = element.action();
    action?.click();
    await settle();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(action?.disabled).toBe(true);
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(2);

    first.resolve(false);
    await settle();
    expect(action?.disabled).toBe(true);
    expect(element.text()).not.toContain(reconnectFailure);

    await element.update({ connected: false });
    expect(action?.disabled).toBe(true);
    second.resolve(false);
    await vi.waitFor(() => expect(action?.disabled).toBe(false));
    expect(element.text()).toContain(reconnectFailure);
    await element.update({ connected: true });
    expect(element.text()).toContain(reconnectFailure);
    expect(action?.textContent).toContain("Retry now");
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "keeps live run controls focused until acknowledgement (compact: %s)",
    async (compact) => {
      const element = await mount(null, { compact, updateRun: createUpdateRunFixture() });
      expect(element.element.textContent).toContain("OpenClaw update in progress: staging");
      expect(element.element.textContent).toContain("phases complete");
      const action = element.action()!;
      const details = element.find("details");
      if (details) {
        details.open = true;
      }
      expect(action.disabled).toBe(false);
      action.focus();
      expect(document.activeElement).toBe(action);

      await element.update({
        updateRun: createUpdateRunFixture({ phase: "verifying", updatedAtMs: 3 }),
      });
      expect(element.element.textContent).toContain("OpenClaw update in progress: verifying");
      expect(element.find(".sidebar-update-card__action")).toBe(action);
      expect(document.activeElement).toBe(action);
      if (details) {
        expect(element.find("details")).toBe(details);
        expect(details.open).toBe(true);
      }

      const completedRun = succeededRun({
        finishedAtMs: Date.now(),
        after: { version: "2026.9.2" },
      });
      await element.update({ updateRun: completedRun });
      expect(element.element.textContent).toContain("OpenClaw updated to 2026.9.2");
      await element.update({ updateRunAcknowledged: true });
      expect(element.find(".sidebar-update-card")).toBeNull();
      await element.update({
        updateRunAcknowledged: false,
        updateRun: { ...completedRun, finishedAtMs: Date.now() - 24 * 60 * 60 * 1000 },
      });
      expect(element.find(".sidebar-update-card")).toBeNull();
    },
  );

  it("renders an available update and narrates it after the Gateway drops its metadata", async () => {
    const element = await mount(
      {
        ...gitUpdate,
        commitsBehind: 246,
        currentSha: "1234567890abcdef",
        upstreamSha: "abc1234def",
      },
      {
        updateSchedule: gitSchedule,
      },
    );
    expect(element.action()?.textContent).toContain("246 commits behind");
    expect(
      [...element.element.querySelectorAll(".update-git-revisions code")].map(
        (code) => code.textContent,
      ),
    ).toEqual(["12345678", "abc1234d"]);

    await element.update({ updateBusy: true });
    const action = element.action();
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Updating Gateway…");

    await element.update({ updateAvailable: null, updateSchedule: null });
    expect(element.element.textContent).toContain("Updating Gateway…");
  });

  it("retires stale git availability after a refreshed current comparison", async () => {
    const element = await mount(
      { ...gitUpdate, commitsBehind: 246 },
      {
        updateSchedule: {
          ...gitSchedule,
          install: { kind: "git", git: { status: "current" } },
        },
      },
    );

    expect(element.find(".sidebar-update-card")).toBeNull();
  });

  it("keeps an available update actionable inside the compact Inbox row", async () => {
    const element = await mount(stableUpdate, {
      compact: true,
      onDismiss: vi.fn(),
      onUpdate: vi.fn(),
    });

    expect(element.find(".sidebar-issues-panel__entity")?.textContent).toBe("Update available");
    expect(element.find("summary time")).toBeNull();
    expect(element.action()?.textContent).toContain("Update Gateway");
    const dismiss = element.find<HTMLButtonElement>(".sidebar-issues-panel__dismiss")!;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss Update available");
    expect(dismiss.querySelector("svg")).not.toBeNull();
    dismiss.click();
    expect(element.props().onDismiss).toHaveBeenCalledOnce();
    expect(element.props().onUpdate).not.toHaveBeenCalled();
    expect(element.find("details")?.open).toBe(false);
  });

  it.each([
    { state: "running", ageMinutes: 30 },
    { state: "campaign", ageMinutes: 20 },
  ] as const)(
    "shows the recorded $state age beside the compact row's detail",
    async ({ state, ageMinutes }) => {
      const now = Date.parse("2026-09-23T12:00:00Z");
      vi.useFakeTimers({ now });
      const element = await mount(null, {
        compact: true,
        updateSchedule:
          state === "campaign"
            ? packageSchedule(
                {
                  state: "countdown",
                  announcedAtMs: now - 20 * 60_000,
                  updatedAtMs: now - 60_000,
                  applyAtMs: now + 10 * 60_000,
                  forceAtMs: now + 60 * 60_000,
                },
                "2026.9.2",
              )
            : undefined,
        updateRun:
          state === "running"
            ? createUpdateRunFixture({
                createdAtMs: now - 30 * 60_000,
                updatedAtMs: now - 60_000,
              })
            : undefined,
      });
      await element.find<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-relative-time",
      )?.updateComplete;

      const title = element.find("summary .sidebar-issues-panel__entity");
      const meta = title?.nextElementSibling;
      const time = meta?.querySelector("time");
      const timestamp = now - ageMinutes * 60_000;
      expect(meta?.querySelector(".sidebar-issues-panel__state")).not.toBeNull();
      expect(time?.getAttribute("datetime")).toBe(new Date(timestamp).toISOString());
      expect(time?.getAttribute("title")).toBe(formatDateTimeMs(timestamp));
      expect(time?.textContent?.trim()).toBe(`${ageMinutes}m ago`);
      expect(element.find("details")?.open).toBe(false);
    },
  );

  it("refreshes a completed update's age without new state and stops ticking on disconnect", async () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    vi.useFakeTimers({ now });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const timersBefore = vi.getTimerCount();
    const element = await mount(null, {
      compact: true,
      updateRun: succeededRun({
        createdAtMs: now - 30 * 60_000,
        updatedAtMs: now - 5 * 60_000,
        finishedAtMs: now - 5 * 60_000,
      }),
    });
    await element.find<HTMLElement & { updateComplete: Promise<boolean> }>("openclaw-relative-time")
      ?.updateComplete;
    expect(element.find("summary time")?.textContent?.trim()).toBe("5m ago");

    await vi.advanceTimersByTimeAsync(60_000);
    const time = element.find("summary time");
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
    const onUpdate = vi.fn();
    const element = await mount(stableUpdate, { canUpdate: false, onUpdate });

    const action = element.action();
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
    vi.useFakeTimers({ now: 1_000 });
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const element = await mount(stableUpdate, {
      updateSchedule: packageSchedule({
        state: "countdown",
        applyAtMs: 55_000,
      }),
    });

    const card = element.find(".sidebar-update-card");
    const timer = element.find("[role='timer']");
    expect(card?.hasAttribute("role")).toBe(false);
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Updating in 0:54 · v2.0.0");
    expect(element.find(".sidebar-update-card__hold")?.textContent?.trim()).toBe("Hold 1 h");

    await element.update({ updateBusy: true });
    expect(element.find(".sidebar-update-card__hold")).toBeNull();
    await element.update({ updateBusy: false });
    expect(element.find(".sidebar-update-card__hold")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(element.find("[role='timer']")?.textContent).toContain("Updating in 0:53");

    element.dispose();
    expect(clearInterval).toHaveBeenCalled();
  });

  it("retries a declined hold and keeps a consumed hold hidden across rerenders after expiry", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const holding = createDeferred<boolean>();
    const onHoldUpdate = vi.fn().mockReturnValueOnce(holding.promise).mockResolvedValue(true);
    const element = await mount(stableUpdate, {
      updateSchedule: packageSchedule({}),
      onHoldUpdate,
    });

    const hold = element.find<HTMLButtonElement>(".sidebar-update-card__hold")!;
    hold.click();
    await settle();
    expect(hold.disabled).toBe(true);
    hold.click();
    expect(onHoldUpdate).toHaveBeenCalledOnce();
    holding.resolve(false);
    await vi.waitFor(() => expect(hold.disabled).toBe(false));
    expect(element.find(".sidebar-update-card__hold")).toBe(hold);
    hold.click();
    await vi.waitFor(() => expect(onHoldUpdate).toHaveBeenCalledTimes(2));
    await element.update({
      heldUpdateCampaignId: "campaign-1",
      updateSchedule: packageSchedule({ holdUntilMs: 61_000 }),
    });
    expect(element.find(".sidebar-update-card__hold")).toBeNull();

    await element.update({
      updateSchedule: packageSchedule({ holdUntilMs: 500 }),
    });
    expect(element.find(".sidebar-update-card__hold")).toBeNull();
  });

  it("renders held timing and gates hold for active or unauthorized campaigns", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const schedule: UpdateScheduleState = {
      ...gitSchedule,
      autoEnabled: true,
      campaign: packageSchedule({
        holdUntilMs: 61_000,
        forceAtMs: 961_000,
        updatedAtMs: 1_000,
      }).campaign,
    };
    const held = await mount(null, { updateSchedule: schedule });
    expect(held.element.textContent).toContain("Update held · resumes in 1:00");
    expect(held.element.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unheldSchedule: UpdateScheduleState = {
      ...schedule,
      campaign: { ...schedule.campaign!, holdUntilMs: undefined },
    };
    const unauthorized = await mount(null, { updateSchedule: unheldSchedule, canUpdate: false });
    expect(unauthorized.element.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unsupported = await mount(null, { updateSchedule: unheldSchedule, canHoldUpdate: false });
    expect(unsupported.element.querySelector(".sidebar-update-card__hold")).toBeNull();
  });
});
