/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { confirmAndStartUpdateRuntime } from "./update-confirmation.runtime.tsx";
import {
  createUpdateProgressWatcher,
  type ConfirmAndStartUpdateParams,
  type UpdateProgress,
} from "./update-confirmation.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

function progress(overrides: Partial<UpdateProgress> = {}): UpdateProgress {
  return { run: null, busy: false, connected: true, failure: null, ...overrides };
}

function createProgressStream(initial: Partial<UpdateProgress> = {}) {
  let emit: ((progress: UpdateProgress) => void) | null = null;
  const stopWatching = vi.fn();
  return {
    stopWatching,
    get stopped() {
      return stopWatching.mock.calls.length > 0;
    },
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      emit = listener;
      listener(progress(initial));
      return stopWatching;
    },
    async push(next: Partial<UpdateProgress>) {
      emit?.(progress(next));
      await Promise.resolve();
      flush();
    },
  };
}

const GIT_AVAILABLE: UpdateAvailable = {
  channel: "dev",
  currentVersion: "2026.9.5",
  latestVersion: "2026.9.5",
  currentSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  repositoryUrl: "https://github.com/example/openclaw",
  commitsBehind: 3,
};
const GIT_TARGET = {
  kind: "git",
  upstreamRef: "origin/main",
  upstreamSha: "b".repeat(40),
  commitsBehind: 6,
} as const;

const UPDATE_AVAILABLE: UpdateAvailable = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
};

function gitSchedule(overrides: Partial<UpdateScheduleState>): UpdateScheduleState {
  return { channel: "dev", autoEnabled: false, ...overrides };
}

function gitComparison(current: string, campaign = false): UpdateScheduleState {
  return gitSchedule({
    install: {
      kind: "git",
      git: {
        status: "behind",
        currentSha: current.repeat(40),
        upstreamSha: "d".repeat(40),
        repositoryUrl: "https://github.com/example/refreshed",
        commitsBehind: 1,
      },
    },
    target: GIT_TARGET,
    campaign: campaign
      ? {
          id: "campaign-1",
          state: "waiting-for-idle",
          announcedAtMs: 1_000,
          forceAtMs: 901_000,
          updatedAtMs: 1_000,
        }
      : undefined,
  });
}

function expectText(element: Element, ...text: string[]) {
  for (const value of text) {
    expect(element.textContent).toContain(value);
  }
}

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

async function finishUpdate(settled: Promise<void>, label = "Close") {
  findButton(label).click();
  await settled;
}

function installNativeBridge(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { openclawUpdate: { postMessage } } },
  });
  return postMessage;
}

function startUpdate(overrides: Partial<ConfirmAndStartUpdateParams> = {}) {
  const startGatewayUpdate = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    isCurrentTarget: () => true,
    canStartNativeUpdate: () => true,
    startGatewayUpdate,
    updateAvailable: UPDATE_AVAILABLE,
    updateSchedule: null,
    viaNativeApp: false,
    ...overrides,
  });
  return { settled, startGatewayUpdate };
}

async function renderUpdate(overrides: Partial<ConfirmAndStartUpdateParams> = {}) {
  const update = startUpdate(overrides);
  return { ...update, ...(await getRenderedModalDialog(document.body)) };
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

it("refuses a native update without a live authority check", async () => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = await renderUpdate({
    viaNativeApp: true,
    canStartNativeUpdate: undefined,
  });
  findButton("Update Mac app and restart").click();
  flush();
  expect(postMessage).not.toHaveBeenCalled();
  expect(startGatewayUpdate).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Administrator access is required",
  );
  await finishUpdate(settled, "Cancel");
});

it.each([false, true])("routes a confirmed Mac update with bridge removed: %s", async (removed) => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate, dialog } = await renderUpdate({ viaNativeApp: true });
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

it.each([
  ["absent", null, "a", "b", 3, "openclaw"],
  [
    "unavailable",
    gitSchedule({
      install: {
        kind: "git",
        git: { status: "unavailable", reason: "fetch-failed", currentSha: "c".repeat(40) },
      },
      target: { ...GIT_TARGET, upstreamSha: "d".repeat(40) },
    }),
    "a",
    "b",
    3,
    "openclaw",
  ],
  ["refreshed", gitComparison("c"), "c", "d", 1, "refreshed"],
  ["campaign", gitComparison("a", true), "a", "b", 3, "openclaw"],
  ["moved campaign", gitComparison("c", true), null, "b", null, null],
] as const)(
  "shows coherent git revisions: %s",
  async (_name, updateSchedule, current, upstream, behind, repository) => {
    const { settled, modal } = await renderUpdate({
      updateAvailable: GIT_AVAILABLE,
      updateSchedule,
    });
    expect(modal.querySelector(".exec-approval-command > div")?.textContent).toBe(
      behind === null
        ? "v2026.9.5"
        : `Installed v2026.9.5 · ${behind} commit${behind === 1 ? "" : "s"} behind`,
    );
    expect(
      [...modal.querySelectorAll(".update-git-revisions code")].map((code) => code.textContent),
    ).toEqual((current ? [current, upstream] : [upstream]).map((sha) => sha.repeat(8)));
    expect(modal.querySelector(".update-git-revisions a")?.getAttribute("href")).toBe(
      current
        ? `https://github.com/example/${repository}/compare/${current.repeat(40)}...${upstream.repeat(40)}`
        : undefined,
    );
    expect(modal.textContent).not.toContain("a".repeat(40));
    await finishUpdate(settled, "Cancel");
  },
);

it.each([
  undefined,
  "https://gitlab.com/example/openclaw",
  "https://github.com.evil.invalid/example/openclaw",
  "https://example-user:example-password@github.com/example/openclaw",
  "javascript:alert(1)",
])("omits unsupported revision links: %s", async (repositoryUrl) => {
  const { settled, modal } = await renderUpdate({
    updateAvailable: { ...GIT_AVAILABLE, repositoryUrl },
  });
  expect(modal.querySelectorAll(".update-git-revisions code")).toHaveLength(2);
  expect(modal.querySelector(".update-git-revisions a")).toBeNull();
  await finishUpdate(settled, "Cancel");
});

type GitState = NonNullable<UpdateScheduleState["install"]>["git"];
it.each<[string | null, number | undefined, GitState, string | null]>([
  [null, 3, undefined, "3 commits behind"],
  ["2026.8.1", 246, { status: "behind", commitsBehind: 1 }, "1 commit behind"],
  ["2026.8.1", 1, { status: "diverged", commitsAhead: 2, commitsBehind: 50 }, "50 commits behind"],
  ["2026.8.1", undefined, { status: "behind", commitsBehind: 50 }, "50 commits behind"],
  ["2026.9.3", 246, { status: "current" }, null],
])(
  "formats the git target from its current comparison: %j",
  async (version, cachedBehind, git, distance) => {
    const { settled, modal } = await renderUpdate({
      updateAvailable:
        version === null
          ? null
          : {
              channel: "dev",
              currentVersion: version,
              latestVersion: version,
              commitsBehind: cachedBehind,
            },
      updateSchedule: gitSchedule({
        install: { kind: "git", git },
        target:
          cachedBehind === undefined
            ? undefined
            : { ...GIT_TARGET, commitsBehind: cachedBehind, upstreamSha: "abc1234" },
      }),
    });
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
    await finishUpdate(settled, "Cancel");
  },
);

it("deduplicates confirmation requests", async () => {
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
  const { settled, startGatewayUpdate, modal } = await renderUpdate({
    watchUpdateProgress: stream.watchUpdateProgress,
    ...(action === "Review update" ? { onReviewUpdate } : {}),
  });

  findButton("Update and restart").click();
  await Promise.resolve();
  expect(startGatewayUpdate).toHaveBeenCalledOnce();
  expect(findButton("Updating…").disabled).toBe(true);
  expect(modal.textContent).toContain("Installing the update on the Gateway");

  await stream.push({ busy: true, connected: false });
  expectText(
    modal,
    "The Gateway disconnected during the update",
    "openclaw triage",
    "on the Gateway host",
    "local coding agent",
  );
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

  await stream.push({ failure });
  expect(modal.textContent).toContain(failure);
  if (action === "Review update") {
    await stream.push({
      failure,
      readError: "Could not check for updates: timeout",
    });
    expectText(modal, failure, "Could not check for updates: timeout");
  }
  expect(onReviewUpdate).not.toHaveBeenCalled();
  await finishUpdate(settled, action);
  expect(stream.stopped).toBe(true);
  expect(onReviewUpdate).toHaveBeenCalledTimes(action === "Review update" ? 1 : 0);
});

it("retains success across restart until closed", async () => {
  const stream = createProgressStream();
  const { settled } = await renderUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
  findButton("Update and restart").click();
  const restarting = createUpdateRunFixture({ phase: "restarting" });
  await stream.push({ run: restarting, busy: true, connected: false });
  const view = document.body.querySelector("openclaw-update-run-view")!;
  await waitForSolid(() => expect(view.textContent).toContain("Gateway restarting…"));
  await stream.push({
    run: createUpdateRunFixture({
      phase: "finished",
      status: "succeeded",
      after: { version: "2026.9.2" },
      finishedAtMs: 10,
    }),
  });
  flush();
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
  expect(view.querySelector(".update-run-view__report")?.textContent).toContain(
    "OpenClaw updated to 2026.9.2",
  );
  await finishUpdate(settled);
  expect(stream.stopped).toBe(true);
});

it.each(["existing", "started", "initial"] as const)(
  "clears a %s run report when its scoped row is retired",
  async (entry) => {
    const run = createUpdateRunFixture(
      entry !== "started" ? { phase: "finished", status: "succeeded", finishedAtMs: 10 } : {},
    );
    const snapshot = progress({ run, busy: run.status === "running" });
    const stream = createProgressStream(entry === "existing" ? snapshot : undefined);
    const onAcknowledge = vi.fn();
    const { settled } = startUpdate({
      ...(entry !== "started" ? { existingRun: run } : {}),
      onAcknowledge,
      watchUpdateProgress: stream.watchUpdateProgress,
      updateAvailable: entry === "initial" ? null : UPDATE_AVAILABLE,
    });
    if (entry !== "initial") {
      await getRenderedModalDialog(document.body);
      if (entry === "started") {
        findButton("Update and restart").click();
        await stream.push(snapshot);
      }
      expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();
      await stream.push({ connected: false });
    }
    expect(stream.stopWatching).toHaveBeenCalledOnce();

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(document.body.classList.contains("update-dialog-open")).toBe(false);
    expect(stream.stopped).toBe(true);
    expect(onAcknowledge).not.toHaveBeenCalled();
    await settled;
  },
);

it("reports unaccepted updates after a retained failure", async () => {
  // Auto-advance lets the modal animate while the admission deadline is fast-forwarded.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const stream = createProgressStream({
      failure: "The update failed at install: ENOSPC: no space left on device, write.",
    });
    const { settled, modal } = await renderUpdate({
      watchUpdateProgress: stream.watchUpdateProgress,
    });

    findButton("Update and restart").click();
    await Promise.resolve();
    expect(modal.textContent).not.toContain("ENOSPC");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(modal.textContent).toContain("The update request went unanswered");
    await finishUpdate(settled);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["succeeded", null, false, false],
  ["succeeded", null, false, true],
  ["skipped", "external-supervisor-update-required", false, true],
  ["skipped", "dirty", true, true],
  ["failed", "build-failed", true, true],
] as const)("offers recovery for %s/%s", async (status, reason, recovery, watch) => {
  const run = createUpdateRunFixture({ status, reason, phase: "finished", finishedAtMs: 4_000 });
  const stream = createProgressStream({ run });
  const onAcknowledge = vi.fn();
  const { settled, startGatewayUpdate, modal } = await renderUpdate({
    existingRun: run,
    onAcknowledge,
    onCheckStatus: vi.fn(async () => true),
    onReviewUpdate: vi.fn(),
    ...(watch ? { watchUpdateProgress: stream.watchUpdateProgress } : {}),
    updateAvailable: watch ? UPDATE_AVAILABLE : null,
  });
  expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();
  expect(startGatewayUpdate).not.toHaveBeenCalled();
  const labels = new Set(
    [...modal.querySelectorAll("button")].map((button) => button.textContent?.trim()),
  );
  expect(
    ["Retry update", "Review update", "Check status"].map((label) => labels.has(label)),
  ).toEqual([recovery, recovery, recovery]);
  await finishUpdate(settled);
  expect(onAcknowledge).toHaveBeenCalledOnce();
  expect(stream.stopped).toBe(watch);
});

it.each([
  { status: "running", entry: "existing" },
  { status: "failed", entry: "existing" },
  { status: "running", entry: "started" },
] as const)("recovers reads for $entry/$status reports", async ({ status, entry }) => {
  const run = createUpdateRunFixture({
    status,
    phase: status === "running" ? "verifying" : "finished",
    finishedAtMs: status === "running" ? null : 4_000,
    reason: status === "failed" ? "build-failed" : null,
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
  const selfUser = { id: "gateway-owner" };
  harness.update({ selfUser });
  const overlays = createApplicationOverlays(harness.gateway);
  let operation: Promise<void> | undefined;
  let statusOperation: Promise<boolean> | undefined;
  let settled: Promise<void> | undefined;
  try {
    await overlays.refreshUpdateStatus();
    const update = await renderUpdate({
      isCurrentTarget: overlays.captureUpdateTarget(),
      ...(entry === "existing" ? { existingRun: run } : {}),
      startGatewayUpdate: () => {
        operation = overlays.runUpdate();
      },
      onCheckStatus: () => (statusOperation = overlays.refreshUpdateStatus()),
      watchUpdateProgress: createUpdateProgressWatcher({ gateway: harness.gateway, overlays }),
    });
    settled = update.settled;
    const { modal } = update;
    if (entry === "started") {
      findButton("Update and restart").click();
      await flushMicrotasks();
      await operation;
    }
    const retainedView = modal.querySelector(".update-run-view");
    expect(retainedView).not.toBeNull();
    // Reconnect the same target before exercising recovery from its retained report.
    harness.update({ phase: "reconnecting", selfUser: undefined });
    harness.update({ phase: "connected", selfUser: undefined });
    await flushMicrotasks();
    harness.update({ selfUser });
    rejectRunReads = true;
    harness.emitEvent("update.run.changed", { ...run, updatedAtMs: run.updatedAtMs + 1 });
    await flushMicrotasks();
    flush();
    const view = modal.querySelector(".update-run-view")!;
    expect(modal.textContent).toContain("Run status read failed");
    expect(view).toBe(retainedView);
    expect(view.getAttribute("data-run-id")).toBe(run.runId);
    expect(view.getAttribute("data-run-status")).toBe(status);
    expect(view.querySelector("h3")?.textContent).toContain(
      status === "running" ? "OpenClaw update in progress: verifying" : `OpenClaw update ${status}`,
    );
    const reportText = view.textContent;
    const expectRetainedReport = () => {
      expect(modal.querySelector(".update-run-view")).toBe(view);
      expect(view.textContent).toBe(reportText);
    };
    const refreshStatus = async (response: Promise<void>) => {
      statusResponse = response;
      findButton("Check status").click();
      await statusOperation;
      flush();
      expectRetainedReport();
    };
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
    flush();
    expect(modal.textContent).not.toContain("Run status read failed");
    expect(modal.querySelector('[role="status"]')?.textContent).toContain("Status refreshed.");
    expectRetainedReport();
    expect(checkoutReads()).toHaveLength(checkoutReadsBeforeCheck + 1);

    await refreshStatus(Promise.reject(new Error("Status refresh unavailable")));
    expect(modal.textContent).toContain("Could not check for updates: Status refresh unavailable");
    expect(modal.textContent).not.toContain("Status refreshed.");
    expect(findButton("Check status").disabled).toBe(false);
    await refreshStatus(Promise.resolve());
    expect(modal.textContent).not.toContain("Could not check for updates");
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
    document.body.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
    await settled;
    await operation;
    overlays.dispose();
  }
});
