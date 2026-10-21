/* @vitest-environment jsdom */

import { createRoot, createSignal, merge } from "solid-js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { UpdateScheduleState } from "../../api/types.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectUpdateSentinel } from "../../app/update-overlay-helpers.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
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

function failedRun() {
  return createUpdateRunFixture({ status: "failed", phase: "finished", reason: "build-failed" });
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

function nativeSettings(snapshot: NativeDeviceSettingsCapability["snapshot"]) {
  return {
    snapshot,
    subscribe: () => () => undefined,
    set: vi.fn(),
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
}

describe("renderUpdates", () => {
  it.each(["Update now", "Retry update"])(
    "dispatches %s to the latest handler without replacing the button",
    (label) => {
      const initial = vi.fn();
      const replacement = vi.fn();
      const [handler, setHandler] = createRoot((dispose) => {
        onTestFinished(dispose);
        return createSignal<() => void>(() => initial);
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
    {
      name: "checking",
      props: { update: { updateStatusRefreshing: true } },
      status: "Checking for updates…",
      tone: "muted",
      label: "Update now",
      disabled: true,
      title: "Checking for updates…",
    },
    {
      name: "updating while a check is pending",
      props: { updateBusy: true, update: { updateStatusRefreshing: true } },
      status: "Update available v2026.8.2",
      tone: "accent",
      label: "Updating…",
      disabled: true,
      title: "",
    },
    {
      name: "failed check with a known update",
      props: {
        update: {
          updateStatusCheckBanner: {
            mode: "manual",
            tone: "warn",
            text: "Could not check for updates: timeout",
          },
        },
      },
      status: "Could not check for updates: timeout",
      tone: "warn",
      label: "Update now",
      disabled: false,
      title: "",
    },
    {
      name: "failed check with a previously confirmed checkout update",
      props: {
        configObject: { update: { channel: "dev", checkOnStart: false } },
        update: {
          updateSchedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git: { status: "behind", commitsBehind: 3 } },
          },
          updateAvailable: null,
          updateStatusCheckBanner: {
            mode: "manual",
            tone: "warn",
            text: "Could not check for updates: timeout",
          },
        },
      },
      status: "Could not check for updates: timeout",
      tone: "warn",
      label: "Update now",
      disabled: false,
      title: "",
    },
    {
      name: "failed check with a previously confirmed diverged checkout update",
      props: {
        configObject: { update: { channel: "dev", checkOnStart: false } },
        update: {
          updateSchedule: {
            channel: "dev",
            autoEnabled: false,
            install: {
              kind: "git",
              git: { status: "diverged", commitsAhead: 1, commitsBehind: 3 },
            },
          },
          updateAvailable: null,
          updateStatusCheckBanner: {
            mode: "manual",
            tone: "warn",
            text: "Could not check for updates: timeout",
          },
        },
      },
      status: "Could not check for updates: timeout",
      tone: "warn",
      label: "Update now",
      disabled: false,
      title: "",
    },
    {
      name: "failed check without a known update",
      props: {
        update: {
          updateSchedule: null,
          updateAvailable: null,
          updateStatusCheckBanner: {
            mode: "manual",
            tone: "warn",
            text: "Could not check for updates: timeout",
          },
        },
      },
      status: "Could not check for updates: timeout",
      tone: "warn",
      label: "Update now",
      disabled: true,
      title: "Check for updates successfully before starting an update.",
    },
    {
      name: "up to date",
      props: {
        update: {
          updateSchedule: { channel: "stable", autoEnabled: false, install: { kind: "package" } },
          updateAvailable: null,
        },
      },
      status: "Up to date",
      tone: "ok",
      label: "Update now",
      disabled: false,
      title: "",
    },
    {
      name: "update available",
      props: {},
      status: "Update available v2026.8.2",
      tone: "accent",
      label: "Update now",
      disabled: false,
      title: "",
    },
    {
      name: "real update failure",
      props: {
        update: { updateStatusBanner: { tone: "danger", text: "Update error: build failed" } },
      },
      status: "Update error: build failed",
      tone: "danger",
      label: "Update now",
      disabled: false,
      title: "",
    },
    {
      name: "restart pending",
      props: {
        updateBusy: true,
        update: {
          updateStatusBanner: {
            tone: "info",
            text: "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
          },
        },
      },
      status:
        "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
      tone: "accent",
      label: "Updating…",
      disabled: true,
      title: "",
    },
  ] satisfies Array<{
    name: string;
    props: UpdatesViewOverrides;
    status: string;
    tone: string;
    label: string;
    disabled: boolean;
    title: string;
  }>)("distinguishes $name", ({ props, status, tone, label, disabled, title }) => {
    const onCheckStatus = vi.fn(async () => true);
    renderUpdates({ ...props, onCheckStatus });
    const statusRow = row("Status");
    expect(statusRow.querySelector(".settings-status")?.textContent?.trim()).toBe(status);
    expect(statusRow.querySelector(".settings-status")?.className).toBe(
      tone === "muted" ? "settings-status" : `settings-status settings-status--${tone}`,
    );
    const button = row("Update now").querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent?.trim()).toBe(label);
    expect(button.disabled).toBe(disabled);
    expect(button.title).toBe(title);
    if (props.update?.updateStatusCheckBanner) {
      expect(container.textContent).not.toContain("Latest update attempt");
      const check = statusRow.querySelector<HTMLButtonElement>("button")!;
      expect(check.textContent?.trim()).toBe("Check for updates");
      expect(check.disabled).toBe(false);
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
      expect(container.textContent).not.toContain("This Mac");
      expect(container.textContent).not.toContain("This iPhone");
      expect(container.textContent).not.toContain("This device");
      expect(container.textContent).not.toContain("App version");
      expect(container.textContent).not.toContain("Check for updates automatically");
      expect(row("Gateway version").textContent).toContain("2026.8.1");
      row("Update now").querySelector<HTMLButtonElement>("button")?.click();
      expect(props.onUpdateNow).toHaveBeenCalledOnce();
      expect(nativeDeviceSettings.checkForUpdates).not.toHaveBeenCalled();
    },
  );

  it("keeps Mac updater controls native and available independently of Gateway admin access", () => {
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
    const automatic = toggle("Check for updates automatically");
    expect(automatic.hasAttribute("disabled")).toBe(false);
    automatic.checked = false;
    automatic.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("updates.automatic", false);
    row("Check for Updates…").querySelector("button")?.click();
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
    expect(row("App version").textContent).toContain("2026.9.4 (build 43)");
    expect(row("App updates unavailable").textContent).toContain("Updater is not bundled");
    expect(container.textContent).not.toContain("Check for updates automatically");
    renderUpdates();
    expect(container.textContent).not.toContain("This Mac");
  });

  it("renders build facts, policy controls, status, and the shared update action", () => {
    const onChannelChange = vi.fn();
    const onAutomaticUpdatesChange = vi.fn();
    const onUpdateNow = vi.fn();
    renderUpdates({ onChannelChange, onAutomaticUpdatesChange, onUpdateNow });

    expect(row("Gateway version").textContent).toContain("2026.8.1");
    expect(row("Control UI commit").textContent).toContain("0123456789ab");
    expect(row("Built").querySelector("time")?.getAttribute("datetime")).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(row("Last commit").querySelector("time")?.getAttribute("datetime")).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(row("Install type").textContent).toContain("Package");
    expect(
      [...container.querySelectorAll(".settings-segmented__btn")].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Stable", "Beta", "Dev"]);
    expect(row("Status").textContent).toContain("Update available v2026.8.2");

    const channel = row("Release channel").querySelector<HTMLElement>('[role="radiogroup"]');
    if (!channel) {
      throw new Error("Missing release channel control");
    }
    const beta = channel.querySelector<HTMLInputElement>('input[type="radio"][value="beta"]');
    if (!beta) {
      throw new Error("Missing beta channel control");
    }
    beta.click();
    expect(onChannelChange).toHaveBeenCalledWith("beta", expect.any(HTMLElement));

    const automatic = toggle("Automatic updates");
    automatic.checked = true;
    automatic.dispatchEvent(new Event("change"));
    expect(onAutomaticUpdatesChange).toHaveBeenCalledWith(true);

    row("Update now").querySelector<HTMLButtonElement>("button")?.click();
    expect(onUpdateNow).toHaveBeenCalledOnce();

    renderUpdates({
      configObject: { update: { channel: "beta", auto: { enabled: true } } },
      onChannelChange,
      onAutomaticUpdatesChange,
      onUpdateNow,
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

    const channel = row("Release channel").querySelector<HTMLElement>('[role="radiogroup"]');
    expect(channel?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(
      "extended-stable",
    );
    expect(
      [...container.querySelectorAll(".settings-segmented__btn")].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Stable", "Beta", "Dev", "Extended stable"]);
    const selected = channel?.querySelector<HTMLInputElement>(
      'input[type="radio"][value="extended-stable"]',
    );
    expect(selected?.checked).toBe(true);
    const automatic = automaticUpdatesControl().toggle;
    expect(automatic.checked).toBe(false);
    expect(automatic.hasAttribute("disabled")).toBe(true);
    expect(row("Automatic updates").textContent).toContain("never installs them automatically");
  });

  it("lets an admin resume disabled checks while preserving the automatic-update preference", () => {
    const onUpdateChecksChange = vi.fn();
    renderUpdates({
      configObject: {
        update: { channel: "stable", checkOnStart: false, auto: { enabled: true } },
      },
      update: { updateSchedule: { channel: "stable", autoEnabled: false } },
      onUpdateChecksChange,
    });

    const checks = toggle("Check for updates");
    expect(checks.checked).toBe(false);
    expect(checks.hasAttribute("disabled")).toBe(false);
    const automatic = automaticUpdatesControl().toggle;
    expect(automatic.checked).toBe(true);
    expect(automatic.hasAttribute("disabled")).toBe(true);
    expect(row("Automatic updates").textContent).toContain("Check for updates");
    checks.checked = true;
    checks.dispatchEvent(new Event("change"));
    expect(onUpdateChecksChange).toHaveBeenCalledWith(true);
  });

  it.each([
    {
      name: "disables dev package installs",
      channel: "dev",
      installKind: "package",
      disabled: true,
      description:
        "Automatic dev updates require a source (git) install. This install is a package install — use stable or beta for automatic updates.",
    },
    {
      name: "allows dev git installs",
      channel: "dev",
      installKind: "git",
      disabled: false,
      description: undefined,
    },
    {
      name: "allows stable package installs",
      channel: "stable",
      installKind: "package",
      disabled: false,
      description: undefined,
    },
  ] as const)("$name", ({ channel, installKind, disabled, description }) => {
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
    expect(automatic.toggle.hasAttribute("disabled")).toBe(disabled);
    if (description) {
      expect(automatic.row.textContent).toContain(description);
    }
  });

  it("renders the authoritative waiting countdown as a quiet timer", () => {
    const onHoldUpdate = vi.fn(async () => true);
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
    hold?.click();
    expect(onHoldUpdate).toHaveBeenCalledOnce();
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
        heldUpdateCampaignId: "campaign-1",
        updateSchedule: {
          channel: "dev",
          autoEnabled: true,
          campaign: {
            id: "campaign-1",
            state: "waiting-for-idle",
            announcedAtMs: 1_000,
            holdUntilMs: 500,
            forceAtMs: 961_000,
            updatedAtMs: 1_000,
          },
        },
        updateAvailable: null,
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
    {
      name: "current",
      git: { status: "current" } as const,
      label: "Up to date",
    },
    {
      name: "ahead",
      git: { status: "ahead", commitsAhead: 2 } as const,
      label: "2 commits ahead of tracked upstream",
    },
    {
      name: "diverged",
      git: { status: "diverged", commitsAhead: 1, commitsBehind: 3 } as const,
      label: "Diverged · 1 ahead, 3 behind",
    },
    {
      name: "fetch unavailable",
      git: { status: "unavailable", reason: "fetch-failed" } as const,
      label: "Could not fetch the tracked upstream",
    },
  ])("renders explicit $name git status without a dot", ({ git, label }) => {
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

  it("keeps retry and report as separate actions for one final failure", () => {
    const onReportFailure = vi.fn(async () => undefined);
    const run = failedRun();
    renderUpdates({
      update: { updateRun: run, reportableUpdateFailureId: run.runId },
      onReportFailure,
    });

    const actions = [...row("Recovery").querySelectorAll<HTMLButtonElement>("button")];
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Check status",
      "Retry update",
      "Report update failure",
    ]);
    actions[2]?.click();
    expect(onReportFailure).toHaveBeenCalledExactlyOnceWith(run.runId);
  });

  it("renders a prefilled issue without exposing a server-local path", () => {
    const run = failedRun();
    renderUpdates({
      update: {
        updateRun: run,
        reportableUpdateFailureId: run.runId,
        updateFailureReportNotice: {
          attemptId: run.runId,
          result: {
            status: "fallback",
            fallbackUrl: "https://github.com/openclaw/openclaw/issues/new?title=update",
            message: "gh is not authenticated",
          },
        },
      },
    });

    const report = row("Failure report");
    expect(report.textContent).toContain("Review and submit the prefilled issue in your browser.");
    expect(report.textContent).not.toContain("/private/report.md");
    expect(report.querySelector("a")?.getAttribute("href")).toContain("issues/new");
  });

  it("renders an ambiguous submission as pending without a replay link", () => {
    const run = failedRun();
    renderUpdates({
      update: {
        updateRun: run,
        reportableUpdateFailureId: run.runId,
        updateFailureReportNotice: {
          attemptId: run.runId,
          result: {
            status: "pending",
            message: "GitHub issue submission may have completed.",
          },
        },
      },
    });

    const report = row("Failure report");
    expect(report.textContent).toContain("may have completed");
    expect(report.querySelector("a")).toBeNull();
  });

  it("keeps read-only facts visible while locking controls for non-admins", () => {
    renderUpdates({ canAdmin: false, canUpdate: false, configBusy: true });

    expect(container.querySelector("[role='note']")?.textContent).toContain(
      "Administrator access is required",
    );
    expect(
      [...row("Release channel").querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    expect(toggle("Automatic updates")?.hasAttribute("disabled")).toBe(true);
    expect(toggle("Check for updates")?.hasAttribute("disabled")).toBe(true);
    expect(row("Update now").querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(row("Status").querySelector("button")).toBeNull();
    expect(row("Gateway version").textContent).toContain("2026.8.1");
  });
});
