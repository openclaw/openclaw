/* @vitest-environment jsdom */

import { createRoot, createSignal, merge } from "solid-js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { UpdateScheduleState } from "../../api/types.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectUpdateSentinel } from "../../app/update-overlay-helpers.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
  nativeSettings,
  createUpdatesViewProps as createProps,
  type UpdatesViewOverrides,
} from "./updates.test-support.ts";

let container: ReturnType<typeof createUpdatesViewDom>["container"];
let mountUpdates: ReturnType<typeof createUpdatesViewDom>["mountUpdates"];
let row: ReturnType<typeof createUpdatesViewDom>["row"];
let automaticUpdatesControl: ReturnType<typeof createUpdatesViewDom>["automaticUpdatesControl"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row, automaticUpdatesControl, mountUpdates } = createUpdatesViewDom());
});

function renderUpdates(overrides: UpdatesViewOverrides = {}) {
  mountUpdates(createProps(overrides));
}

function toggle(title: string) {
  return row(title).querySelector<HTMLInputElement>('input[role="switch"]')!;
}

function rowButton(title: string) {
  return row(title).querySelector<HTMLButtonElement>("button")!;
}

function text(title: string) {
  return row(title).textContent;
}

function setToggle(title: string, checked: boolean) {
  const input = toggle(title);
  input.checked = checked;
  input.dispatchEvent(new Event("change"));
  return input;
}

function failedRun() {
  return createUpdateRunFixture({ status: "failed", phase: "finished", reason: "build-failed" });
}

const checkFailure = {
  mode: "manual",
  tone: "warn",
  text: "Could not check for updates: timeout",
} as const;
const restartPending =
  "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.";
const gitSchedule = (git: NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]>) =>
  ({ channel: "dev", autoEnabled: false, install: { kind: "git", git } }) as const;

function statusCase(
  name: string,
  props: UpdatesViewOverrides,
  status = "Update available v2026.8.2",
  tone = "accent",
  button: Partial<Pick<HTMLButtonElement, "disabled" | "title"> & { label: string }> = {},
) {
  return {
    name,
    props,
    status,
    tone,
    button: { disabled: false, title: "", label: "Update Gateway…", ...button },
  };
}

function checkProps(gitStatus?: "behind" | "diverged"): UpdatesViewOverrides {
  return {
    ...(gitStatus ? { configObject: { update: { channel: "dev", checkOnStart: false } } } : {}),
    update: {
      updateSchedule: gitStatus
        ? gitSchedule(
            gitStatus === "diverged"
              ? { status: "diverged", commitsBehind: 3, commitsAhead: 1 }
              : { status: "behind", commitsBehind: 3 },
          )
        : null,
      updateAvailable: null,
      updateStatusCheckBanner: checkFailure,
    },
  };
}

function gitUpdate(git: NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]>) {
  return {
    updateSchedule: { channel: "dev", autoEnabled: false, install: { kind: "git", git } },
    updateAvailable: null,
  } satisfies NonNullable<UpdatesViewOverrides["update"]>;
}

type Campaign = NonNullable<UpdateScheduleState["campaign"]>;
function waitingUpdate(campaign: Pick<Campaign, "forceAtMs"> & Partial<Campaign>) {
  return {
    updateSchedule: {
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" },
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "a".repeat(40),
        commitsBehind: 3,
      },
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 1_000,
        updatedAtMs: 1_000,
        ...campaign,
      },
    },
    updateAvailable: null,
  } satisfies NonNullable<UpdatesViewOverrides["update"]>;
}

describe("renderUpdates", () => {
  it.each([
    ["available", {}, "Install the available update and restart the Gateway."],
    [
      "current",
      {
        updateSchedule: { channel: "stable", autoEnabled: false, install: { kind: "package" } },
        updateAvailable: null,
      },
      "Run the Gateway updater and restart. The current version may be reinstalled.",
    ],
    [
      "unknown",
      { updateSchedule: null, updateAvailable: null },
      "Run the Gateway updater and restart. The current version may be reinstalled.",
    ],
  ] as const)("identifies the Gateway action with %s status", (_status, update, description) => {
    renderUpdates({ update });
    const action = row("Update Gateway…");
    expect(action.textContent).toContain(description);
    expect(action.querySelector("button")?.classList.contains("primary")).toBe(false);
  });

  it.each(["Update Gateway…", "Retry update"])(
    "dispatches %s to the latest handler without replacing the button",
    (label) => {
      const initial = vi.fn(async () => undefined);
      const replacement = vi.fn(async () => undefined);
      const [handler, setHandler] = createRoot((dispose) => {
        onTestFinished(dispose);
        return createSignal<() => Promise<void>>(() => initial);
      });
      const update = label === "Retry update" ? { updateRun: failedRun() } : undefined;
      mountUpdates(
        merge(createProps({ update }), {
          get onUpdateNow() {
            return handler();
          },
        }),
      );
      const button = () =>
        [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (candidate) => candidate.textContent?.trim() === label,
        );
      const retained = button()!;

      setHandler(() => replacement);
      flush();
      expect(button()).toBe(retained);
      retained.click();

      expect(initial).not.toHaveBeenCalled();
      expect(replacement).toHaveBeenCalledOnce();
    },
  );

  it.each([
    statusCase(
      "checking",
      { update: { updateStatusRefreshing: true } },
      "Checking for updates…",
      "muted",
      { disabled: true, title: "Checking for updates…" },
    ),
    statusCase(
      "updating while checking",
      { updateBusy: true, update: { updateStatusRefreshing: true } },
      undefined,
      undefined,
      { disabled: true, label: "Updating…" },
    ),
    statusCase(
      "failed check with update",
      { update: { updateStatusCheckBanner: checkFailure } },
      checkFailure.text,
      "warn",
    ),
    ...(["behind", "diverged"] as const).map((status) =>
      statusCase(
        `failed check with ${status} checkout`,
        checkProps(status),
        checkFailure.text,
        "warn",
      ),
    ),
    statusCase("failed check without update", checkProps(), checkFailure.text, "warn", {
      disabled: true,
      title: "Check for updates successfully before starting an update.",
    }),
    statusCase(
      "up to date",
      {
        update: {
          updateSchedule: { channel: "stable", autoEnabled: false, install: { kind: "package" } },
          updateAvailable: null,
        },
      },
      "Up to date",
      "ok",
    ),
    statusCase("update available", {}),
    statusCase(
      "real update failure",
      { update: { updateStatusBanner: { tone: "danger", text: "Update error: build failed" } } },
      "Update error: build failed",
      "danger",
    ),
    statusCase(
      "restart pending",
      { updateBusy: true, update: { updateStatusBanner: { tone: "info", text: restartPending } } },
      restartPending,
      undefined,
      { disabled: true, label: "Updating…" },
    ),
  ])("distinguishes $name", ({ props, status, tone, button: expected }) => {
    const onCheckStatus = vi.fn(async () => true);
    renderUpdates({ ...props, onCheckStatus });
    const statusRow = row("Status");
    const statusElement = statusRow.querySelector(".settings-status");
    expect([statusElement?.textContent?.trim(), statusElement?.className]).toEqual([
      status,
      tone === "muted" ? "settings-status" : `settings-status settings-status--${tone}`,
    ]);
    const button = row("Update Gateway…").querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent?.trim()).toBe(expected.label);
    expect(button).toMatchObject({ disabled: expected.disabled, title: expected.title });
    if (props.update?.updateStatusCheckBanner) {
      expect(container.textContent).not.toContain("Latest update attempt");
      const check = statusRow.querySelector<HTMLButtonElement>("button")!;
      expect([check.textContent?.trim(), check.disabled]).toEqual(["Check for updates", false]);
      check.click();
      expect(onCheckStatus).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])(
    "keeps a previous update failure visible during a check (pending: %s)",
    (statusChecking) => {
      renderUpdates({
        update: {
          updateStatusRefreshing: statusChecking,
          updateStatusBanner: { tone: "danger", text: "Update error: build failed" },
          updateStatusCheckBanner: statusChecking
            ? null
            : { mode: "manual", tone: "warn", text: "Could not check for updates: timeout" },
        },
      });
      expect(row("Status").textContent).toContain(
        statusChecking ? "Checking for updates…" : "Could not check for updates: timeout",
      );
      expect(row("Failure details").textContent).toContain("Update error: build failed");
    },
  );

  it.each(["ios", "waiting"])(
    "keeps Gateway updates without an advertised device updater: %s",
    (host) => {
      const nativeDeviceSettings = nativeSettings(
        host === "ios" ? createIosNativeDeviceSettingsSnapshot() : null,
      );
      const props = createProps({ nativeDeviceSettings });
      mountUpdates(props);
      expect(container.textContent).not.toMatch(
        /This Mac|This iPhone|This device|App version|Check for updates automatically/,
      );
      expect(text("Gateway version")).toContain("2026.8.1");
      rowButton("Update Gateway…").click();
      expect(props.onUpdateNow).toHaveBeenCalledOnce();
      expect(nativeDeviceSettings.checkForUpdates).not.toHaveBeenCalled();
    },
  );

  it("keeps Mac updater controls native and available independently of Gateway admin access", async () => {
    const nativeListeners = new Set<Parameters<NativeDeviceSettingsCapability["subscribe"]>[0]>();
    const snapshot = createNativeDeviceSettingsSnapshot();
    const nativeDeviceSettings = {
      ...nativeSettings(snapshot),
      snapshot,
      subscribe: (listener) => {
        nativeListeners.add(listener);
        return () => {
          nativeListeners.delete(listener);
        };
      },
    } satisfies NativeDeviceSettingsCapability;
    const props = createProps({ nativeDeviceSettings, canAdmin: false, configBusy: true });
    mountUpdates(props);
    expect(container.textContent).toContain("This Mac");
    expect(row("App version").textContent).toContain("2026.9.3 (build 42)");
    expect(toggle("Check for updates automatically").hasAttribute("aria-disabled")).toBe(false);
    setToggle("Check for updates automatically", false);
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "updates.automatic",
      false,
      expect.any(Function),
    );
    const appUpdateButton = rowButton("Check for Updates…");
    expect(appUpdateButton.classList.contains("primary")).toBe(true);
    appUpdateButton.click();
    expect(nativeDeviceSettings.checkForUpdates).toHaveBeenCalledOnce();
    nativeDeviceSettings.snapshot = {
      ...nativeDeviceSettings.snapshot,
      device: { ...nativeDeviceSettings.snapshot.device, appVersion: "2026.9.4", appBuild: "43" },
      updates: {
        ...nativeDeviceSettings.snapshot.updates,
        available: false,
        unavailableReason: "Updater is not bundled",
      },
    };
    for (const listener of nativeListeners) {
      listener(nativeDeviceSettings.snapshot);
    }
    flush();
    await waitForSolid(() =>
      expect(row("App version").textContent).toContain("2026.9.4 (build 43)"),
    );
    expect(row("App updates unavailable").textContent).toContain("Updater is not bundled");
    expect(container.textContent).not.toContain("Check for updates automatically");
    renderUpdates();
    await waitForSolid(() => expect(container.textContent).not.toContain("This Mac"));
  });

  it("renders build facts and retains policy controls across a config refresh", () => {
    const onAutomaticUpdatesChange = vi.fn();
    renderUpdates({ onAutomaticUpdatesChange });
    expect(text("Gateway version")).toContain("2026.8.1");
    expect(text("Control UI commit")).toContain("0123456789ab");
    expect(
      ["Built", "Last commit"].map((title) => row(title).querySelector("time")?.dateTime),
    ).toEqual(["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"]);
    expect(text("Install type")).toContain("Package");
    const beta = row("Release channel").querySelector<HTMLInputElement>('input[value="beta"]')!;
    const automatic = setToggle("Automatic updates", true);
    expect(onAutomaticUpdatesChange).toHaveBeenCalledWith(true);
    renderUpdates({
      configObject: { update: { channel: "beta", auto: { enabled: true } } },
    });
    expect(toggle("Automatic updates")).toBe(automatic);
    expect(row("Release channel").querySelector('input[value="beta"]')).toBe(beta);
    expect(automatic.checked).toBe(true);
    expect(beta.checked).toBe(true);
  });

  it("reports a configless extended-stable package install by the Gateway channel and gates auto-apply", () => {
    // A direct `npm install -g openclaw@extended-stable` never writes update.channel;
    // the Gateway still resolves and publishes extended-stable as the schedule channel.
    renderUpdates({
      configObject: { update: { auto: { enabled: true } } },
      update: {
        updateSchedule: {
          channel: "extended-stable",
          autoEnabled: true,
          install: { kind: "package" },
        },
        updateAvailable: null,
      },
    });

    expect(
      [...container.querySelectorAll(".settings-segmented__btn")].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Stable", "Beta", "Dev", "Extended stable"]);
    expect(row("Release channel").querySelector("input:checked")).toMatchObject({
      value: "extended-stable",
    });
    const automatic = automaticUpdatesControl().toggle;
    expect(automatic.checked).toBe(false);
    expect(automatic.hasAttribute("aria-disabled")).toBe(true);
    expect(row("Automatic updates").textContent).toContain("never installs them automatically");
  });

  it.each([
    ["dev", "package", true],
    ["dev", "git", false],
    ["stable", "package", false],
  ] as const)("gates automatic %s updates for %s installs", (channel, installKind, disabled) => {
    renderUpdates({
      configObject: { update: { channel, auto: { enabled: false } } },
      update: {
        updateSchedule: {
          channel,
          autoEnabled: false,
          install: { kind: installKind },
        },
      },
    });

    const automatic = automaticUpdatesControl();
    expect(automatic.toggle.hasAttribute("aria-disabled")).toBe(disabled);
    if (disabled) {
      expect(automatic.row.textContent).toContain(
        "Automatic dev updates require a source (git) install. This install is a package install — use stable or beta for automatic updates.",
      );
    }
  });

  it("keeps the waiting timer mounted and retries a declined hold", async () => {
    const holding = createDeferred<boolean>();
    const onHoldUpdate = vi.fn().mockReturnValueOnce(holding.promise).mockResolvedValue(true);
    const props = createProps({
      update: waitingUpdate({ forceAtMs: 762_000 }),
      onHoldUpdate,
    });
    mountUpdates(props);

    const timer = row("Status").querySelector("[role='timer']");
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Waiting for active work · forced update in 12:41");
    mountUpdates({ ...props, nowMs: 61_000 });
    expect(row("Status").querySelector("[role='timer']")).toBe(timer);
    expect(timer?.textContent).toContain("Waiting for active work · forced update in 11:41");
    const hold = row("Status").querySelector<HTMLButtonElement>("button");
    expect(hold?.textContent?.trim()).toBe("Hold 1 h");
    hold!.click();
    await waitForSolid(() => expect(hold!.disabled).toBe(true));
    hold!.click();
    expect(onHoldUpdate).toHaveBeenCalledOnce();
    expect(row("Status").querySelector("[role='timer']")).toBe(timer);
    holding.resolve(false);
    await waitForSolid(() => expect(hold!.disabled).toBe(false));
    expect(row("Status").querySelector("button")).toBe(hold);
    hold!.click();
    expect(onHoldUpdate).toHaveBeenCalledTimes(2);
    await waitForSolid(() => expect(hold!.disabled).toBe(false));
  });

  it("keeps a replacement campaign usable while a retired hold settles", async () => {
    const retired = createDeferred<boolean>();
    const current = createDeferred<boolean>();
    const onHoldUpdate = vi
      .fn()
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(current.promise);
    renderUpdates({ update: waitingUpdate({ forceAtMs: 762_000 }), onHoldUpdate });
    const hold = row("Status").querySelector<HTMLButtonElement>("button")!;
    hold.click();
    await waitForSolid(() => expect(hold.disabled).toBe(true));

    renderUpdates({
      update: waitingUpdate({ id: "campaign-2", forceAtMs: 762_000 }),
      onHoldUpdate,
    });
    const replacement = row("Status").querySelector<HTMLButtonElement>("button")!;
    expect(replacement.disabled).toBe(false);
    retired.resolve(false);
    await retired.promise;
    await waitForSolid(() => expect(replacement.disabled).toBe(false));
    replacement.click();
    expect(onHoldUpdate).toHaveBeenCalledTimes(2);
    await waitForSolid(() => expect(replacement.disabled).toBe(true));
    current.resolve(false);
    await waitForSolid(() => expect(replacement.disabled).toBe(false));
  });

  it("shows held campaign timing and hides the one-shot hold action", () => {
    const props = createProps({
      update: waitingUpdate({ forceAtMs: 961_000, holdUntilMs: 61_000 }),
    });
    mountUpdates(props);

    expect(row("Status").textContent).toContain("Update held · resumes in 1:00");
    expect(row("Status").querySelector("button")).toBeNull();
    mountUpdates({ ...props, nowMs: 31_000 });
    expect(row("Status").textContent).toContain("Update held · resumes in 0:30");
    expect(row("Status").querySelector("button")).toBeNull();
    mountUpdates({ ...props, nowMs: 61_000 });
    expect(row("Status").textContent).toContain("Waiting for active work · forced update in 15:00");
    expect(row("Status").querySelector("button")?.textContent?.trim()).toBe("Hold 1 h");

    renderUpdates({
      update: {
        ...waitingUpdate({ forceAtMs: 961_000, holdUntilMs: 500 }),
        heldUpdateCampaignId: "campaign-1",
      },
    });
    expect(row("Status").querySelector("button")).toBeNull();
  });

  it("shows truthful Git build, install, and commit ages", () => {
    const installedAtMs = Date.parse("2026-08-08T12:00:00Z");
    const commitAtMs = Date.parse("2026-08-08T10:00:00Z");
    renderUpdates({
      configObject: { update: { channel: "dev" } },
      nowMs: Date.parse("2026-08-08T14:00:00Z"),
      update: gitUpdate({
        status: "current",
        currentSha: "a".repeat(40),
        commitAtMs,
        installedAtMs,
      }),
    });

    expect(row("Installed").querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T12:00:00.000Z",
    );
    expect(row("Installed").textContent).toContain("2h ago");
    expect(row("Last commit").querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T10:00:00.000Z",
    );
    expect(row("Last commit").textContent).toContain("4h ago");

    renderUpdates({
      configObject: { update: { channel: "dev" } },
      update: gitUpdate({ status: "current" }),
    });
    expect(row("Installed").querySelector(".settings-row__value")?.textContent).toBe("Unknown");
  });

  it.each([
    [{ status: "current" }, "Up to date"],
    [{ status: "ahead", commitsAhead: 2 }, "2 commits ahead of tracked upstream"],
    [{ status: "diverged", commitsAhead: 1, commitsBehind: 3 }, "Diverged · 1 ahead, 3 behind"],
    [{ status: "unavailable", reason: "fetch-failed" }, "Could not fetch the tracked upstream"],
  ] as const)("renders explicit %j git status without a dot", (git, label) => {
    renderUpdates({
      configObject: { update: { channel: "dev" } },
      update: gitUpdate(git),
    });

    expect(row("Status").textContent).toContain(label);
    expect(row("Status").querySelector(".settings-status__dot")).toBeNull();
  });

  it.each([
    { status: "succeeded", reason: null, recovery: false, reconciled: false },
    { status: "failed", reason: "build-failed", recovery: true, reconciled: false },
    { status: "skipped", reason: "dirty", recovery: true, reconciled: false },
    {
      status: "skipped",
      reason: "external-supervisor-update-required",
      recovery: false,
      reconciled: false,
    },
    { status: "skipped", reason: "container-image-install", recovery: false, reconciled: false },
    { status: "skipped", reason: "already-current", recovery: false, reconciled: false },
    { status: "failed", reason: "abandoned", recovery: false, reconciled: true },
  ] as const)(
    "renders the durable $status/$reason report with reconciled=$reconciled and only offers current recovery",
    ({ status, reason, recovery, reconciled }) => {
      const onUpdateNow = vi.fn();
      const onCheckStatus = vi.fn(async () => true);
      renderUpdates({
        update: {
          updateRun: createUpdateRunFixture({
            phase: "finished",
            status,
            finishedAtMs: 10,
            reason,
            after: { version: "2026.9.2" },
            steps: [
              {
                step: "build",
                status: status === "failed" ? "failed" : "completed",
                detail: "Build output",
              },
              ...(reconciled
                ? [{ step: "reconcile:acknowledged", status: "completed" as const }]
                : []),
            ],
          }),
        },
        onUpdateNow,
        onCheckStatus,
      });
      flush();
      const view = container.querySelector("openclaw-update-run-view")!;
      expect(view.querySelector(".update-run-view__report")?.textContent).toContain(
        reconciled
          ? "OpenClaw abandoned update reconciled."
          : status === "succeeded"
            ? "OpenClaw updated to 2026.9.2"
            : `OpenClaw update ${status}`,
      );
      if (recovery) {
        const actions = row("Recovery");
        actions.querySelector<HTMLButtonElement>("button")?.click();
        actions.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
        expect(onCheckStatus).toHaveBeenCalledOnce();
        expect(onUpdateNow).toHaveBeenCalledOnce();
        expect(row("CLI fallback").querySelector("code")?.textContent).toBe("openclaw triage");
      } else {
        expect(container.textContent).not.toContain("Retry update");
        expect(container.textContent).not.toContain("openclaw triage");
      }
      if (reconciled) {
        expect(view.querySelector(".update-run-view__report--failed")).toBeNull();
        expect(view.querySelector('[data-step="build"]')?.getAttribute("data-status")).toBe(
          "failed",
        );
        expect(view.querySelector(".update-run-view__details")?.textContent).toContain(
          "Build output",
        );
      }
    },
  );

  it.each([
    { reason: "external-supervisor-update-required", recovery: false },
    { reason: "already-current", recovery: false },
    { reason: "dirty", recovery: true },
  ])(
    "keeps the retained $reason sentinel outcome without false recovery",
    ({ reason, recovery }) => {
      const projected = projectUpdateSentinel({
        kind: "update",
        status: "skipped",
        ts: 10,
        stats: { reason },
      })!;
      renderUpdates({
        update: {
          updateStatusBanner: projected.banner,
          recordedUpdateAttempt: projected.attempt,
        },
      });

      expect(row("Status").textContent).toContain(reason);
      expect(container.textContent?.includes("Retry update")).toBe(recovery);
      expect(container.textContent?.includes("CLI fallback")).toBe(recovery);
      expect(container.textContent?.includes("openclaw triage")).toBe(recovery);
    },
  );

  it.each([
    ["fallback", "Review and submit the prefilled issue in your browser."],
    ["pending", "may have completed"],
  ] as const)(
    "renders a %s issue submission without leaking a path or replay link",
    (status, message) => {
      const run = failedRun();
      renderUpdates({
        update: {
          updateRun: run,
          reportableUpdateFailureId: run.runId,
          updateFailureReportNotice: {
            attemptId: run.runId,
            result:
              status === "fallback"
                ? {
                    status,
                    fallbackUrl: "https://github.com/openclaw/openclaw/issues/new?title=update",
                    message: "gh is not authenticated",
                  }
                : { status, message: "GitHub issue submission may have completed." },
          },
        },
      });

      const report = row("Failure report");
      expect(report.textContent).toContain(message);
      expect(report.textContent).not.toContain("/private/report.md");
      if (status === "fallback") {
        expect(report.querySelector("a")?.getAttribute("href")).toContain("issues/new");
      } else {
        expect(report.querySelector("a")).toBeNull();
      }
    },
  );
});
