/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { findButton } from "../test-helpers/dom-probe.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
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

function makeProgress(overrides: Partial<UpdateProgress> = {}): UpdateProgress {
  return { run: null, busy: false, connected: true, failure: null, ...overrides };
}

/** Drives the dialog the way the shell does: one live lifecycle stream. */
function createProgressStream(initial: Partial<UpdateProgress> = {}) {
  let emit: ((progress: UpdateProgress) => void) | null = null;
  const stopWatching = vi.fn();
  return {
    stopWatching,
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      emit = listener;
      listener(makeProgress(initial));
      return stopWatching;
    },
    async push(next: Partial<UpdateProgress>) {
      emit?.(makeProgress(next));
      await Promise.resolve();
      flush();
    },
  };
}

const UPDATE_AVAILABLE: UpdateAvailable = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
};
const GIT_AVAILABLE: UpdateAvailable = {
  channel: "dev",
  currentVersion: "2026.9.5",
  latestVersion: "2026.9.5",
  currentSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  repositoryUrl: "https://github.com/example/openclaw",
  commitsBehind: 3,
};

function gitSchedule(
  git: NonNullable<UpdateScheduleState["install"]>["git"],
  overrides: Partial<UpdateScheduleState> = {},
): UpdateScheduleState {
  return { channel: "dev", autoEnabled: false, install: { kind: "git", git }, ...overrides };
}

const sha = (letter: string) => letter.repeat(40);
const gitTarget = (upstream = "b") => ({
  kind: "git" as const,
  upstreamRef: "origin/main",
  upstreamSha: sha(upstream),
  commitsBehind: 6,
});
const campaign = {
  id: "campaign-1",
  state: "waiting-for-idle" as const,
  announcedAtMs: 1_000,
  forceAtMs: 901_000,
  updatedAtMs: 1_000,
};
function comparedSchedule(current: string, activeCampaign = false) {
  return gitSchedule(
    {
      status: "behind",
      currentSha: sha(current),
      upstreamSha: sha("d"),
      repositoryUrl: "https://github.com/example/refreshed",
      commitsBehind: 1,
    },
    { target: gitTarget(), ...(activeCampaign ? { campaign } : {}) },
  );
}

async function dismiss(settled: Promise<void>, label = "Cancel") {
  findButton(label).click();
  await settled;
}

let restoreDialogPolyfill: () => void;
let originalWebkit: PropertyDescriptor | undefined;

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

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

it.each(["current", "unknown"] as const)(
  "warns that a %s Gateway may be reinstalled before confirmation",
  async (status) => {
    const { settled, startGatewayUpdate } = startUpdate({
      updateAvailable: null,
      updateSchedule:
        status === "current"
          ? { channel: "stable", autoEnabled: false, install: { kind: "package" } }
          : null,
    });
    const { dialog } = await getRenderedModalDialog(document.body);
    expect(dialog.textContent).toContain("The current version may be reinstalled.");
    expect(dialog.textContent).not.toContain("Installs the available update");
    await dismiss(settled);
    expect(startGatewayUpdate).not.toHaveBeenCalled();
  },
);

afterEach(() => {
  document.body.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
  document.body.replaceChildren();
  restoreDialogPolyfill();
  restorePropertyDescriptor(window, "webkit", originalWebkit);
});

it("refuses a native update without a live authority check", async () => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({
    viaNativeApp: true,
    canStartNativeUpdate: undefined,
  });
  await getRenderedModalDialog(document.body);
  findButton("Update Mac app and restart").click();
  flush();
  expect(postMessage).not.toHaveBeenCalled();
  expect(startGatewayUpdate).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Administrator access is required",
  );
  await dismiss(settled);
});

it("falls back to the Gateway when the Mac update bridge disappears", async () => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  const { dialog } = await getRenderedModalDialog(document.body);
  expect(dialog.getAttribute("aria-label")).toBe("Update Mac app + Gateway");
  Reflect.deleteProperty(window, "webkit");
  findButton("Update Mac app and restart").click();
  await settled;
  expect(startGatewayUpdate).toHaveBeenCalledOnce();
  expect(postMessage).not.toHaveBeenCalled();
});

it.each([
  ["absent", null, 3, "a", "b", "openclaw"],
  [
    "unavailable",
    gitSchedule(
      { status: "unavailable", reason: "fetch-failed", currentSha: sha("c") },
      { target: gitTarget("d") },
    ),
    3,
    "a",
    "b",
    "openclaw",
  ],
  ["refreshed", comparedSchedule("c"), 1, "c", "d", "refreshed"],
  ["campaign", comparedSchedule("a", true), 3, "a", "b", "openclaw"],
  ["moved campaign", comparedSchedule("c", true), null, null, "b", null],
] as const)(
  "shows coherent git revisions with %s comparison metadata",
  async (_comparison, updateSchedule, behind, current, upstream, repository) => {
    const { settled } = startUpdate({
      updateAvailable: GIT_AVAILABLE,
      updateSchedule,
    });
    const { modal } = await getRenderedModalDialog(document.body);
    expect(modal.querySelector(".exec-approval-command > div")?.textContent).toBe(
      behind === null
        ? "v2026.9.5"
        : `Installed v2026.9.5 · ${behind} commit${behind === 1 ? "" : "s"} behind`,
    );
    expect(
      [...modal.querySelectorAll(".update-git-revisions code")].map((code) => code.textContent),
    ).toEqual([...(current ? [current.repeat(8)] : []), upstream.repeat(8)]);
    expect(modal.querySelector(".update-git-revisions a")?.getAttribute("href")).toBe(
      repository
        ? `https://github.com/example/${repository}/compare/${sha(current!)}...${sha(upstream)}`
        : undefined,
    );
    expect(modal.textContent).not.toContain("a".repeat(40));
    await dismiss(settled);
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
    updateAvailable: { ...GIT_AVAILABLE, repositoryUrl },
  });
  const { modal } = await getRenderedModalDialog(document.body);
  expect(modal.querySelectorAll(".update-git-revisions code")).toHaveLength(2);
  expect(modal.querySelector(".update-git-revisions a")).toBeNull();
  await dismiss(settled);
});

it.each([
  [null, 3, undefined, "3 commits behind"],
  ["2026.8.1", 246, { status: "behind", commitsBehind: 1 }, "1 commit behind"],
  ["2026.8.1", 1, { status: "diverged", commitsAhead: 2, commitsBehind: 50 }, "50 commits behind"],
  ["2026.8.1", undefined, { status: "behind", commitsBehind: 50 }, "50 commits behind"],
  ["2026.9.3", 246, { status: "current" }, null],
] as const)(
  "formats the git target from its current comparison: %s/%s/%j",
  async (version, cachedBehind, git, distance) => {
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
      updateSchedule: gitSchedule(git, {
        target:
          cachedBehind === undefined
            ? undefined
            : {
                commitsBehind: cachedBehind,
                kind: "git",
                upstreamRef: "origin/main",
                upstreamSha: "abc1234",
              },
      }),
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
    await dismiss(settled);
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
  await stream.push({ busy: true, connected: false });
  expect(modal.textContent).toContain("The Gateway disconnected during the update");
  expect(modal.textContent).toContain("openclaw triage");
  expect(modal.textContent).toContain("on the Gateway host");
  expect(modal.textContent).toContain("local coding agent");
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

  await stream.push({ failure });
  expect(modal.textContent).toContain(failure);
  if (action === "Review update") {
    await stream.push({
      failure,
      readError: "Could not check for updates: timeout",
    });
    expect(modal.textContent).toContain(failure);
    expect(modal.textContent).toContain("Could not check for updates: timeout");
  }
  expect(onReviewUpdate).not.toHaveBeenCalled();
  findButton(action).click();
  await settled;
  expect(stream.stopWatching).toHaveBeenCalledOnce();
  expect(onReviewUpdate).toHaveBeenCalledTimes(action === "Review update" ? 1 : 0);
});

it.each(["close", "retire"] as const)(
  "keeps streaming progress and recovery controls live while checking status until %s",
  async (exit) => {
    const run = createUpdateRunFixture({ phase: "verifying" });
    const stream = createProgressStream({
      run,
      busy: true,
      readError: "Synthetic retained read failure",
    });
    const pending = createDeferred<boolean>();
    const onCheckStatus = vi.fn(() => pending.promise);
    const { settled } = startUpdate({
      existingRun: run,
      onCheckStatus,
      watchUpdateProgress: stream.watchUpdateProgress,
    });
    const { modal } = await getRenderedModalDialog(document.body);
    const report = modal.querySelector(".update-run-view");
    const check = findButton("Check status");
    try {
      check.click();
      check.click();
      expect(onCheckStatus).toHaveBeenCalledOnce();
      await waitForSolid(() => expect(findButton("Checking status…").disabled).toBe(true));

      await stream.push({
        run: { ...run, phase: "restarting", updatedAtMs: run.updatedAtMs + 1 },
        busy: true,
        connected: false,
      });
      expect(modal.querySelector(".update-run-view")).toBe(report);
      expect(report?.textContent).toContain("Gateway restarting…");
      expect(findButton("Checking status…")).toBe(check);
      expect(modal.textContent).toContain("Reconnect to the Gateway");

      if (exit === "close") {
        findButton("Close").click();
      } else {
        await stream.push({ connected: false });
      }
      await settled;
      pending.resolve(true);
      await pending.promise;
      await flushMicrotasks();
      flush();
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(stream.stopWatching).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(false);
      document.body
        .querySelector("openclaw-modal-dialog")
        ?.dispatchEvent(new Event("modal-cancel"));
      await settled;
    }
  },
);

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
        await stream.push(progress);
      }
      expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();
      await stream.push({ connected: false });
    }
    expect(stream.stopWatching).toHaveBeenCalledOnce();

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(document.body.classList.contains("update-dialog-open")).toBe(false);
    expect(onAcknowledge).not.toHaveBeenCalled();
    await settled;
  },
);

it("reports an unaccepted update after a retained failure as unanswered", async () => {
  // Auto-advance lets the modal animate while the admission deadline is fast-forwarded.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const stream = createProgressStream({
      failure: "The update failed at install: ENOSPC: no space left on device, write.",
    });
    const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
    const { modal } = await getRenderedModalDialog(document.body);

    findButton("Update and restart").click();
    await Promise.resolve();
    expect(modal.textContent).not.toContain("ENOSPC");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(modal.textContent).toContain("The update request went unanswered");
    await dismiss(settled, "Close");
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
] as const)(
  "offers update recovery only for failed %s/%s outcomes (recovery=%s, watch=%s)",
  async (status, reason, recovery, watch) => {
    const run = createUpdateRunFixture({ status, reason, phase: "finished", finishedAtMs: 4_000 });
    const stream = createProgressStream({ run });
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
    expect(
      ["Retry update", "Review update", "Check status"].map((label) => labels.has(label)),
    ).toEqual([recovery, recovery, recovery]);
    await dismiss(settled, "Close");
    expect(onAcknowledge).toHaveBeenCalledOnce();
    expect(stream.stopWatching).toHaveBeenCalledTimes(watch ? 1 : 0);
  },
);

it.each(["running", "failed"] as const)(
  "keeps the %s report through status read failure and recovery",
  async (status) => {
    const run = createUpdateRunFixture({
      status,
      phase: status === "running" ? "verifying" : "finished",
      finishedAtMs: status === "running" ? null : 4_000,
      reason: status === "failed" ? "build-failed" : null,
    });
    let rejectRunReads = false;
    let statusResponse: Promise<void> = Promise.resolve();
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.runs.get") {
        if (rejectRunReads) {
          throw new Error("Run status read failed");
        }
        return { run };
      }
      if (method === "update.status") {
        await statusResponse;
        return { [status === "running" ? "activeRun" : "lastRun"]: run };
      }
      return {};
    });
    const harness = updateRunHarness(request);
    const selfUser = { id: "gateway-owner" };
    harness.update({ selfUser });
    const overlays = createApplicationOverlays(harness.gateway);
    const startGatewayUpdate = vi.fn();
    let settled: Promise<void> | undefined;
    let statusOperation: Promise<boolean> | undefined;
    try {
      await overlays.refreshUpdateStatus();
      settled = confirmAndStartUpdateRuntime({
        isCurrentTarget: overlays.captureUpdateTarget(),
        existingRun: run,
        startGatewayUpdate,
        onCheckStatus: () => (statusOperation = overlays.refreshUpdateStatus()),
        watchUpdateProgress: createUpdateProgressWatcher({ gateway: harness.gateway, overlays }),
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: null,
        viaNativeApp: false,
      });
      const { modal } = await getRenderedModalDialog(document.body);
      const view = modal.querySelector(".update-run-view")!;
      harness.update({ phase: "reconnecting", selfUser: undefined });
      harness.update({ phase: "connected", selfUser: undefined });
      await flushMicrotasks();
      harness.update({ selfUser });
      rejectRunReads = true;
      harness.emitEvent("update.run.changed", { ...run, updatedAtMs: run.updatedAtMs + 1 });
      await flushMicrotasks();
      flush();
      expect(modal.textContent).toContain("Run status read failed");
      expect(modal.querySelector(".update-run-view")).toBe(view);
      expect(view.getAttribute("data-run-id")).toBe(run.runId);
      expect(view.getAttribute("data-run-status")).toBe(status);
      expect(view.querySelector("h3")?.textContent).toContain(
        status === "running" ? "OpenClaw update in progress: verifying" : "OpenClaw update failed",
      );
      const check = findButton("Check status");
      const reportText = view.textContent;
      const expectRetainedReport = () => {
        expect(modal.querySelector(".update-run-view")).toBe(view);
        expect(view.textContent).toBe(reportText);
      };
      expect(check.disabled).toBe(false);
      if (status === "running") {
        expect(
          [...modal.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Retry update",
          ),
        ).toBe(false);
      }
      const failure = "Could not check for updates: Status refresh unavailable";
      for (const attempt of ["success", "failure", "retry"]) {
        const pending = createDeferred<void>();
        statusResponse = pending.promise;
        check.click();
        await flushMicrotasks();
        expect(findButton("Checking status…")).toBe(check);
        expect(check.disabled).toBe(true);
        if (status === "failed") {
          expect(findButton("Retry update").disabled).toBe(true);
        }
        if (attempt === "retry") {
          expect(modal.textContent).toContain(failure);
          expect(modal.textContent).not.toContain("Status refreshed.");
        }
        expectRetainedReport();
        if (attempt === "failure") {
          pending.reject(new Error("Status refresh unavailable"));
        } else {
          pending.resolve();
        }
        await statusOperation;
        flush();
        await waitForSolid(() => expect(findButton("Check status").disabled).toBe(false));
        if (attempt === "failure") {
          expect(modal.textContent).toContain(failure);
          expect(modal.textContent).not.toContain("Status refreshed.");
        } else {
          expect(modal.textContent).not.toContain("Run status read failed");
          expect(modal.textContent).not.toContain("Could not check for updates");
          await waitForSolid(() =>
            expect(modal.querySelector('[role="status"]')?.textContent).toContain(
              "Status refreshed.",
            ),
          );
        }
        expectRetainedReport();
      }
      harness.update({ phase: "connecting", client: null });
      await flushMicrotasks();
      expect(findButton("Check status").disabled).toBe(true);
      expect(modal.textContent).toContain("Reconnect to the Gateway");
      if (status === "failed") {
        expect(findButton("Retry update").disabled).toBe(true);
      }
      const requestsBeforeDisconnectClick = request.mock.calls.length;
      findButton("Check status").click();
      expect(request.mock.calls).toHaveLength(requestsBeforeDisconnectClick);
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(0);
      expect(startGatewayUpdate).not.toHaveBeenCalled();
    } finally {
      document.body
        .querySelector("openclaw-modal-dialog")
        ?.dispatchEvent(new Event("modal-cancel"));
      await settled;
      overlays.dispose();
    }
  },
);
