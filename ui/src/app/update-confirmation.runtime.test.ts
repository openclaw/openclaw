/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { confirmAndStartUpdateRuntime } from "./update-confirmation.runtime.ts";
import {
  createUpdateProgressWatcher,
  type ConfirmAndStartUpdateParams,
  type UpdateProgress,
} from "./update-confirmation.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

/** Drives the dialog the way the shell does: one live lifecycle stream. */
function createProgressStream(
  initial: UpdateProgress = { run: null, busy: false, connected: true, failure: null },
) {
  let emit: ((progress: UpdateProgress) => void) | null = null;
  let stopped = false;
  const stopWatching = vi.fn(() => {
    stopped = true;
  });
  return {
    stopWatching,
    get stopped() {
      return stopped;
    },
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      emit = listener;
      listener(initial);
      return stopWatching;
    },
    async push(progress: UpdateProgress) {
      emit?.(progress);
      await Promise.resolve();
    },
  };
}

const UPDATE_AVAILABLE: UpdateAvailable = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
};

let restoreDialogPolyfill: () => void;
let originalWebkit: PropertyDescriptor | undefined;

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

function installNativeBridge(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { openclawUpdate: { postMessage } } },
  });
  return postMessage;
}

function startUpdate(
  overrides: Partial<Omit<ConfirmAndStartUpdateParams, "startGatewayUpdate">> = {},
) {
  const startGatewayUpdate = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    startGatewayUpdate,
    updateAvailable: UPDATE_AVAILABLE,
    updateSchedule: null,
    viaNativeApp: false,
    ...overrides,
  });
  return { settled, startGatewayUpdate };
}

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(() => {
  document.body.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
  document.body.replaceChildren();
  restoreDialogPolyfill();
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
});

it.each([false, true])("routes a confirmed Mac update with bridge removed: %s", async (removed) => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  const { dialog } = await getRenderedModalDialog(document.body);
  expect(dialog.getAttribute("aria-label")).toBe("Update Mac app + Gateway");
  if (removed) {
    Reflect.deleteProperty(window, "webkit");
  }
  findButton("Update Mac app and restart").click();
  await settled;
  if (removed) {
    expect(startGatewayUpdate).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
  } else {
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
    expect(startGatewayUpdate).not.toHaveBeenCalled();
  }
});

it.each(["absent", "unavailable", "refreshed", "campaign", "moved campaign"] as const)(
  "shows coherent git revisions with %s comparison metadata",
  async (comparison) => {
    const campaign = comparison === "campaign" || comparison === "moved campaign";
    const refreshed = comparison === "refreshed" || campaign;
    const { settled } = startUpdate({
      updateAvailable: {
        channel: "dev",
        currentVersion: "2026.9.5",
        latestVersion: "2026.9.5",
        currentSha: "a".repeat(40),
        upstreamSha: "b".repeat(40),
        repositoryUrl: "https://github.com/example/openclaw",
        commitsBehind: 3,
      },
      updateSchedule: refreshed
        ? {
            channel: "dev",
            autoEnabled: false,
            install: {
              kind: "git",
              git: {
                status: "behind",
                currentSha: (comparison === "campaign" ? "a" : "c").repeat(40),
                upstreamSha: "d".repeat(40),
                repositoryUrl: "https://github.com/example/refreshed",
                commitsBehind: 1,
              },
            },
            target: {
              kind: "git",
              upstreamRef: "origin/main",
              upstreamSha: "b".repeat(40),
              commitsBehind: 6,
            },
            ...(campaign
              ? {
                  campaign: {
                    id: "campaign-1",
                    state: "waiting-for-idle" as const,
                    announcedAtMs: 1_000,
                    forceAtMs: 901_000,
                    updatedAtMs: 1_000,
                  },
                }
              : {}),
          }
        : comparison === "unavailable"
          ? {
              channel: "dev",
              autoEnabled: false,
              install: {
                kind: "git",
                git: { status: "unavailable", reason: "fetch-failed", currentSha: "c".repeat(40) },
              },
              target: {
                kind: "git",
                upstreamRef: "origin/main",
                upstreamSha: "d".repeat(40),
                commitsBehind: 6,
              },
            }
          : null,
    });
    const { modal } = await getRenderedModalDialog(document.body);
    expect(modal.querySelector(".exec-approval-command > div")?.textContent).toBe(
      comparison === "moved campaign"
        ? "v2026.9.5"
        : comparison === "refreshed"
          ? "Installed v2026.9.5 · 1 commit behind"
          : "Installed v2026.9.5 · 3 commits behind",
    );
    expect(
      [...modal.querySelectorAll(".update-git-revisions code")].map((code) => code.textContent),
    ).toEqual(
      comparison === "moved campaign"
        ? ["bbbbbbbb"]
        : comparison === "refreshed"
          ? ["cccccccc", "dddddddd"]
          : ["aaaaaaaa", "bbbbbbbb"],
    );
    expect(modal.querySelector(".update-git-revisions a")?.getAttribute("href")).toBe(
      comparison === "moved campaign"
        ? undefined
        : comparison === "refreshed"
          ? `https://github.com/example/refreshed/compare/${"c".repeat(40)}...${"d".repeat(40)}`
          : `https://github.com/example/openclaw/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
    );
    expect(modal.textContent).not.toContain("a".repeat(40));
    findButton("Cancel").click();
    await settled;
  },
);

it.each([
  undefined,
  "https://gitlab.com/example/openclaw",
  "https://github.com.evil.invalid/example/openclaw",
  "https://example-user:example-password@github.com/example/openclaw",
  "javascript:alert(1)",
])("keeps revisions readable without a supported GitHub link: %s", async (repositoryUrl) => {
  const { settled } = startUpdate({
    updateAvailable: {
      channel: "dev",
      currentVersion: "2026.9.5",
      latestVersion: "2026.9.5",
      currentSha: "a".repeat(40),
      upstreamSha: "b".repeat(40),
      commitsBehind: 3,
      repositoryUrl,
    },
  });
  const { modal } = await getRenderedModalDialog(document.body);
  expect(modal.querySelectorAll(".update-git-revisions code")).toHaveLength(2);
  expect(modal.querySelector(".update-git-revisions a")).toBeNull();
  findButton("Cancel").click();
  await settled;
});

it.each<{
  version: string | null;
  cachedBehind?: number;
  git?: NonNullable<UpdateScheduleState["install"]>["git"];
  distance: string | null;
}>([
  { version: null, cachedBehind: 3, distance: "3 commits behind" },
  { version: "2026.8.1", cachedBehind: 246, distance: "246 commits behind" },
  {
    version: "2026.8.1",
    cachedBehind: 1,
    git: { status: "behind", commitsBehind: 50 },
    distance: "50 commits behind",
  },
  {
    version: "2026.8.1",
    cachedBehind: 246,
    git: { status: "behind", commitsBehind: 1 },
    distance: "1 commit behind",
  },
  {
    version: "2026.8.1",
    cachedBehind: 1,
    git: { status: "diverged", commitsAhead: 2, commitsBehind: 50 },
    distance: "50 commits behind",
  },
  {
    version: "2026.8.1",
    git: { status: "behind", commitsBehind: 50 },
    distance: "50 commits behind",
  },
  { version: "2026.9.3", cachedBehind: 246, git: { status: "current" }, distance: null },
  {
    version: "2026.9.3",
    cachedBehind: 246,
    git: { status: "ahead", commitsAhead: 1 },
    distance: null,
  },
])(
  "formats the git target from its current comparison: %j",
  async ({ version, cachedBehind, git, distance }) => {
    const { settled } = startUpdate({
      updateAvailable:
        version === null
          ? null
          : {
              channel: "dev",
              currentVersion: version,
              latestVersion: version,
              commitsBehind: cachedBehind,
            },
      updateSchedule: {
        channel: "dev",
        autoEnabled: false,
        install: { kind: "git", git },
        target:
          cachedBehind === undefined
            ? undefined
            : {
                commitsBehind: cachedBehind,
                kind: "git",
                upstreamRef: "origin/main",
                upstreamSha: "abc1234",
              },
      },
    });
    const { modal } = await getRenderedModalDialog(document.body);
    if (version === null) {
      expect(modal.textContent).toContain(distance);
      expect(modal.querySelector(".update-git-revisions code")?.textContent).toBe("abc1234");
    } else if (distance) {
      expect(modal.textContent).toContain(`Installed v${version} · ${distance}`);
      expect(modal.textContent).not.toContain(`Available ${distance}`);
    } else {
      expect(modal.textContent).toContain(`v${version}`);
      expect(modal.textContent).not.toContain("246 commits behind");
      expect(modal.querySelector(".update-git-revisions")).toBeNull();
    }
    findButton("Cancel").click();
    await settled;
  },
);

it("keeps a repeated request from stacking a second confirmation or update", async () => {
  const first = startUpdate();
  const second = startUpdate();
  await getRenderedModalDialog(document.body);

  await second.settled;
  expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
  expect(second.startGatewayUpdate).not.toHaveBeenCalled();

  findButton("Update and restart").click();
  await first.settled;
  expect(first.startGatewayUpdate).toHaveBeenCalledOnce();
});

it.each([
  {
    action: "Close",
    failure: "The update failed at install: ENOSPC: no space left on device, write.",
  },
  { action: "Review update", failure: "Read the recorded cause before retrying." },
])("keeps install failures visible until $action", async ({ action, failure }) => {
  const stream = createProgressStream();
  const onReviewUpdate = vi.fn();
  const { settled, startGatewayUpdate } = startUpdate({
    watchUpdateProgress: stream.watchUpdateProgress,
    ...(action === "Review update" ? { onReviewUpdate } : {}),
  });
  const { modal } = await getRenderedModalDialog(document.body);

  findButton("Update and restart").click();
  await Promise.resolve();
  expect(startGatewayUpdate).toHaveBeenCalledOnce();
  const updating = findButton("Updating…");
  expect(updating.disabled).toBe(true);
  expect(modal.textContent).toContain("Installing the update on the Gateway");

  // The Gateway goes away mid-install; the dialog is mounted outside the shell
  // precisely so it can keep reporting through the disconnect.
  await stream.push({ run: null, busy: true, connected: false, failure: null });
  expect(modal.textContent).toContain("The Gateway disconnected during the update");
  expect(modal.textContent).toContain("openclaw triage");
  expect(modal.textContent).toContain("on the Gateway host");
  expect(modal.textContent).toContain("local coding agent");
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

  await stream.push({
    run: null,
    busy: false,
    connected: true,
    failure,
  });
  expect(modal.textContent).toContain(failure);
  if (action === "Review update") {
    await stream.push({
      run: null,
      busy: false,
      connected: true,
      failure,
      readError: "Could not check for updates: timeout",
    });
    expect(modal.textContent).toContain(failure);
    expect(modal.textContent).toContain("Could not check for updates: timeout");
  }
  expect(onReviewUpdate).not.toHaveBeenCalled();
  findButton(action).click();
  await settled;
  expect(stream.stopped).toBe(true);
  expect(onReviewUpdate).toHaveBeenCalledTimes(action === "Review update" ? 1 : 0);
});

it("does not show a supervisor command after an unrelated request failure and status refresh", async () => {
  const guidance = {
    version: 1 as const,
    action: "update" as const,
    name: "Example Fleet",
    command: "fleet update example",
  };
  const request = vi.fn<RequestFn>(async (method) => {
    if (method === "update.run") {
      throw new Error("Update request rejected: invalid parameters");
    }
    return method === "update.status" ? { externalSupervisorGuidance: guidance } : {};
  });
  const harness = updateRunHarness(request);
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    await flushMicrotasks();
    const settled = confirmAndStartUpdateRuntime({
      startGatewayUpdate: () => {
        void overlays.runUpdate();
      },
      watchUpdateProgress: createUpdateProgressWatcher({ gateway: harness.gateway, overlays }),
      onCheckStatus: () => overlays.refreshUpdateStatus(),
      updateAvailable: UPDATE_AVAILABLE,
      updateSchedule: null,
      viaNativeApp: false,
    });
    const { modal } = await getRenderedModalDialog(document.body);
    findButton("Update and restart").click();
    await flushMicrotasks();
    expect(modal.textContent).toContain("invalid parameters");
    findButton("Check status").click();
    await flushMicrotasks();
    expect(overlays.snapshot.externalSupervisorGuidance).toEqual(guidance);
    expect(modal.textContent).toContain("invalid parameters");
    expect(modal.querySelector(".external-supervisor-guidance")).toBeNull();
    findButton("Close").click();
    await settled;
  } finally {
    overlays.dispose();
  }
});

it("keeps the server success report visible across restart until the operator closes it", async () => {
  const stream = createProgressStream();
  const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
  await getRenderedModalDialog(document.body);
  findButton("Update and restart").click();
  const restarting = createUpdateRunFixture({ phase: "restarting" });
  await stream.push({ run: restarting, busy: true, connected: false, failure: null });
  const view = document.body.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "openclaw-update-run-view",
  )!;
  await view.updateComplete;
  expect(view.textContent).toContain("Gateway restarting…");
  await stream.push({
    run: createUpdateRunFixture({
      phase: "finished",
      status: "succeeded",
      after: { version: "2026.9.2" },
      finishedAtMs: 10,
    }),
    busy: false,
    connected: true,
    failure: null,
  });
  await view.updateComplete;
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
  expect(view.querySelector(".update-run-view__report")?.textContent).toContain(
    "OpenClaw updated to 2026.9.2",
  );
  findButton("Close").click();
  await settled;
  expect(stream.stopped).toBe(true);
});

it.each(["existing", "started", "initial"] as const)(
  "clears a %s run report when its scoped row is retired",
  async (entry) => {
    const run = createUpdateRunFixture(
      entry !== "started" ? { phase: "finished", status: "succeeded", finishedAtMs: 10 } : {},
    );
    const progress: UpdateProgress = {
      run,
      busy: run.status === "running",
      connected: true,
      failure: null,
    };
    const stream = createProgressStream(entry === "existing" ? progress : undefined);
    const onAcknowledge = vi.fn();
    const settled = confirmAndStartUpdateRuntime({
      ...(entry !== "started" ? { existingRun: run } : {}),
      onAcknowledge,
      startGatewayUpdate: vi.fn(),
      watchUpdateProgress: stream.watchUpdateProgress,
      updateAvailable: entry === "initial" ? null : UPDATE_AVAILABLE,
      updateSchedule: null,
      viaNativeApp: false,
    });
    if (entry !== "initial") {
      await getRenderedModalDialog(document.body);
      if (entry === "started") {
        findButton("Update and restart").click();
        await stream.push(progress);
      }
      expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();
      await stream.push({ run: null, busy: false, connected: false, failure: null });
    }
    expect(stream.stopWatching).toHaveBeenCalledOnce();

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(document.body.classList.contains("update-dialog-open")).toBe(false);
    expect(stream.stopped).toBe(true);
    expect(onAcknowledge).not.toHaveBeenCalled();
    await settled;
  },
);

it.each([
  { name: "an empty snapshot", failure: null },
  {
    name: "a retained failure",
    failure: "The update failed at install: ENOSPC: no space left on device, write.",
  },
])("reports an unaccepted update after $name as unanswered", async ({ failure }) => {
  // Auto-advance lets the modal animate while the admission deadline is fast-forwarded.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const stream = createProgressStream({ run: null, busy: false, connected: true, failure });
    const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
    const { modal } = await getRenderedModalDialog(document.body);

    findButton("Update and restart").click();
    await Promise.resolve();
    if (failure) {
      expect(modal.textContent).not.toContain("ENOSPC");
    }

    await vi.advanceTimersByTimeAsync(5_000);
    expect(modal.textContent).toContain("The update request went unanswered");
    findButton("Close").click();
    await settled;
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { status: "succeeded", reason: null, recovery: false, watch: false },
  { status: "succeeded", reason: null, recovery: false, watch: true },
  {
    status: "skipped",
    reason: "external-supervisor-update-required",
    recovery: false,
    watch: true,
  },
  { status: "skipped", reason: "container-image-install", recovery: false, watch: true },
  { status: "skipped", reason: "already-current", recovery: false, watch: true },
  { status: "skipped", reason: "dirty", recovery: true, watch: true },
  { status: "failed", reason: "build-failed", recovery: true, watch: true },
] as const)(
  "offers update recovery only for failed $status/$reason outcomes",
  async ({ status, reason, recovery, watch }) => {
    const run = createUpdateRunFixture({ status, reason, phase: "finished", finishedAtMs: 4_000 });
    const stream = createProgressStream({ run, busy: false, connected: true, failure: null });
    const onAcknowledge = vi.fn();
    const { settled, startGatewayUpdate } = startUpdate({
      existingRun: run,
      onAcknowledge,
      onCheckStatus: vi.fn(async () => true),
      onReviewUpdate: vi.fn(),
      ...(watch ? { watchUpdateProgress: stream.watchUpdateProgress } : {}),
      updateAvailable: watch ? UPDATE_AVAILABLE : null,
    });
    const { modal } = await getRenderedModalDialog(document.body);
    expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();
    expect(startGatewayUpdate).not.toHaveBeenCalled();
    const labels = new Set(
      [...modal.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    );
    expect(labels.has("Retry update")).toBe(recovery);
    expect(labels.has("Review update")).toBe(recovery);
    expect(labels.has("Check status")).toBe(recovery);
    findButton("Close").click();
    await settled;
    expect(onAcknowledge).toHaveBeenCalledOnce();
    expect(stream.stopped).toBe(watch);
  },
);

it.each([
  { status: "running", entry: "existing" },
  { status: "failed", entry: "existing" },
  { status: "succeeded", entry: "existing" },
  { status: "skipped", entry: "existing" },
  { status: "running", entry: "started" },
] as const)(
  "keeps the $status report and exposes read recovery for a $entry run",
  async ({ status, entry }) => {
    const run = createUpdateRunFixture({
      status,
      phase: status === "running" ? "verifying" : "finished",
      finishedAtMs: status === "running" ? null : 4_000,
      reason:
        status === "failed"
          ? "build-failed"
          : status === "skipped"
            ? "external-supervisor-update-required"
            : null,
    });
    let admitted = entry === "existing";
    let rejectRunReads = false;
    let statusResponse: Promise<void> = Promise.resolve();
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        admitted = true;
        return { runId: run.runId };
      }
      if (method === "update.runs.get") {
        if (rejectRunReads) {
          throw new Error("Run status read failed");
        }
        return { run };
      }
      if (method === "update.status") {
        await statusResponse;
      }
      return method === "update.status" && admitted
        ? { [status === "running" ? "activeRun" : "lastRun"]: run }
        : {};
    });
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    let operation: Promise<void> | undefined;
    let statusOperation: Promise<boolean> | undefined;
    let settled: Promise<void> | undefined;
    try {
      await overlays.refreshUpdateStatus();
      settled = confirmAndStartUpdateRuntime({
        ...(entry === "existing" ? { existingRun: run } : {}),
        startGatewayUpdate: () => {
          operation = overlays.runUpdate();
        },
        onCheckStatus: () => (statusOperation = overlays.refreshUpdateStatus()),
        watchUpdateProgress: createUpdateProgressWatcher({ gateway: harness.gateway, overlays }),
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: null,
        viaNativeApp: false,
      });
      const { modal } = await getRenderedModalDialog(document.body);
      if (entry === "started") {
        findButton("Update and restart").click();
        await flushMicrotasks();
        await operation;
      }
      rejectRunReads = true;
      harness.emitEvent("update.run.changed", { ...run, updatedAtMs: run.updatedAtMs + 1 });
      await flushMicrotasks();
      const view = modal.querySelector<
        HTMLElement & { run: unknown; updateComplete: Promise<boolean> }
      >("openclaw-update-run-view")!;
      await view.updateComplete;
      expect(modal.textContent).toContain("Run status read failed");
      expect(view.run).toEqual(run);
      const check = findButton("Check status");
      expect(check.disabled).toBe(false);
      if (status !== "failed") {
        expect(
          [...modal.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Retry update",
          ),
        ).toBe(false);
      }
      const pendingStatus = createDeferred();
      statusResponse = pendingStatus.promise;
      const checkoutReads = () =>
        request.mock.calls.filter(
          ([method, params]) =>
            method === "update.status" &&
            expect.objectContaining({ refreshCheckout: true }).asymmetricMatch(params),
        );
      const checkoutReadsBeforeCheck = checkoutReads().length;
      check.click();
      await flushMicrotasks();
      expect(findButton("Checking status…").disabled).toBe(true);
      if (status === "failed") {
        expect(findButton("Retry update").disabled).toBe(true);
      }
      check.click();
      pendingStatus.resolve();
      await statusOperation;
      expect(modal.textContent).not.toContain("Run status read failed");
      expect(modal.querySelector('[role="status"]')?.textContent).toContain("Status refreshed.");
      expect(view.run).toEqual(run);
      expect(checkoutReads()).toHaveLength(checkoutReadsBeforeCheck + 1);

      statusResponse = Promise.reject(new Error("Status refresh unavailable"));
      findButton("Check status").click();
      await statusOperation;
      expect(modal.textContent).toContain(
        "Could not check for updates: Status refresh unavailable",
      );
      expect(modal.textContent).not.toContain("Status refreshed.");
      expect(findButton("Check status").disabled).toBe(false);
      expect(view.run).toEqual(run);
      statusResponse = Promise.resolve();
      findButton("Check status").click();
      await statusOperation;
      expect(modal.textContent).not.toContain("Could not check for updates");
      expect(view.run).toEqual(run);
      harness.update({ phase: "connecting", client: null });
      await flushMicrotasks();
      expect(findButton("Check status").disabled).toBe(true);
      expect(modal.textContent).toContain("Reconnect to the Gateway");
      if (status === "failed") {
        expect(findButton("Retry update").disabled).toBe(true);
      }
      findButton("Check status").click();
      expect(checkoutReads()).toHaveLength(checkoutReadsBeforeCheck + 3);
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(
        entry === "started" ? 1 : 0,
      );
    } finally {
      document.body
        .querySelector("openclaw-modal-dialog")
        ?.dispatchEvent(new Event("modal-cancel"));
      await settled;
      await operation;
      overlays.dispose();
    }
  },
);
