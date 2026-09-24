/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectUpdateSentinel } from "../../app/update-overlay-helpers.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
  createUpdatesViewProps as createProps,
  type UpdatesViewOverrides,
} from "./updates.test-support.ts";
import { renderUpdates } from "./updates.ts";

let container: HTMLDivElement;
let row: ReturnType<typeof createUpdatesViewDom>["row"];
let automaticUpdatesControl: ReturnType<typeof createUpdatesViewDom>["automaticUpdatesControl"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row, automaticUpdatesControl } = createUpdatesViewDom());
});

describe("renderUpdates", () => {
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
    render(renderUpdates(createProps({ ...props, onCheckStatus })), container);
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
      render(
        renderUpdates(
          createProps({
            update: {
              updateStatusRefreshing: statusChecking,
              updateStatusBanner: { tone: "danger", text: "Update error: build failed" },
              updateStatusCheckBanner: statusChecking
                ? null
                : { mode: "manual", tone: "warn", text: "Could not check for updates: timeout" },
            },
          }),
        ),
        container,
      );
      expect(row("Status").textContent).toContain(
        statusChecking ? "Checking for updates…" : "Could not check for updates: timeout",
      );
      expect(row("Failure details").textContent).toContain("Update error: build failed");
    },
  );

  it.each(["ios", "waiting"])(
    "keeps Gateway updates without an advertised device updater: %s",
    (host) => {
      const nativeDeviceSettings = {
        snapshot: host === "ios" ? createIosNativeDeviceSettingsSnapshot() : null,
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
      const props = createProps({ nativeDeviceSettings });
      render(renderUpdates(props), container);
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
    const nativeDeviceSettings = {
      snapshot: createNativeDeviceSettingsSnapshot(),
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
    const props = createProps({ nativeDeviceSettings, canAdmin: false, configBusy: true });
    render(renderUpdates(props), container);
    expect(container.textContent).toContain("This Mac");
    expect(row("App version").textContent).toContain("2026.9.3 (build 42)");
    const automatic = row("Check for updates automatically").querySelector<
      HTMLElement & { checked: boolean }
    >("wa-switch")!;
    expect(automatic.hasAttribute("disabled")).toBe(false);
    automatic.checked = false;
    automatic.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("updates.automatic", false);
    row("Check for Updates…").querySelector("button")?.click();
    expect(nativeDeviceSettings.checkForUpdates).toHaveBeenCalledOnce();
    nativeDeviceSettings.snapshot!.updates.available = false;
    nativeDeviceSettings.snapshot!.updates.unavailableReason = "Updater is not bundled";
    render(renderUpdates(props), container);
    expect(row("App updates unavailable").textContent).toContain("Updater is not bundled");
    expect(container.textContent).not.toContain("Check for updates automatically");
    render(renderUpdates(createProps()), container);
    expect(container.textContent).not.toContain("This Mac");
  });

  it("renders build facts, policy controls, status, and the shared update action", () => {
    const onChannelChange = vi.fn();
    const onAutomaticUpdatesChange = vi.fn();
    const onUpdateNow = vi.fn();
    render(
      renderUpdates(createProps({ onChannelChange, onAutomaticUpdatesChange, onUpdateNow })),
      container,
    );

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
      [...container.querySelectorAll("wa-radio")].map((option) => option.textContent?.trim()),
    ).toEqual(["Stable", "Beta", "Dev"]);
    expect(row("Status").textContent).toContain("Update available v2026.8.2");

    const channel = row("Release channel").querySelector<HTMLElement & { value: string }>(
      "wa-radio-group",
    );
    if (!channel) {
      throw new Error("Missing release channel control");
    }
    channel.value = "beta";
    channel.dispatchEvent(new Event("change"));
    expect(onChannelChange).toHaveBeenCalledWith("beta", expect.any(HTMLElement));

    const automatic = row("Automatic updates").querySelector<HTMLElement & { checked: boolean }>(
      "wa-switch",
    );
    if (!automatic) {
      throw new Error("Missing automatic updates control");
    }
    automatic.checked = true;
    automatic.dispatchEvent(new Event("change"));
    expect(onAutomaticUpdatesChange).toHaveBeenCalledWith(true);

    row("Update now").querySelector<HTMLButtonElement>("button")?.click();
    expect(onUpdateNow).toHaveBeenCalledOnce();
  });

  it("shows extended stable for an authored channel and disables auto-apply", () => {
    render(
      renderUpdates(
        createProps({
          configObject: {
            update: { channel: "extended-stable", auto: { enabled: true } },
          },
          update: {
            updateSchedule: { channel: "extended-stable", autoEnabled: true },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );

    expect(
      [...container.querySelectorAll("wa-radio")].map((option) => option.textContent?.trim()),
    ).toEqual(["Stable", "Beta", "Dev", "Extended stable"]);
    const automaticRow = row("Automatic updates");
    expect(automaticRow.textContent).toContain("never installs them automatically");
    expect(automaticRow.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
  });

  it("reports a configless extended-stable package install by the Gateway channel and gates auto-apply", () => {
    // A direct `npm install -g openclaw@extended-stable` never writes update.channel;
    // the Gateway still resolves and publishes extended-stable as the schedule channel.
    render(
      renderUpdates(
        createProps({
          configObject: { update: { auto: { enabled: true } } },
          update: {
            updateSchedule: {
              channel: "extended-stable",
              autoEnabled: true,
              install: { kind: "package" },
            },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );

    const channel = row("Release channel").querySelector<HTMLElement & { value: string }>(
      "wa-radio-group",
    );
    expect(channel?.value).toBe("extended-stable");
    expect(
      [...container.querySelectorAll("wa-radio")].map((option) => option.textContent?.trim()),
    ).toEqual(["Stable", "Beta", "Dev", "Extended stable"]);
    const selected = channel?.querySelector<HTMLElement & { checked: boolean }>(
      'wa-radio[value="extended-stable"]',
    );
    expect(selected?.checked).toBe(true);
    const automatic = automaticUpdatesControl().toggle;
    expect(automatic.checked).toBe(false);
    expect(automatic.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the authored channel ahead of the Gateway schedule channel", () => {
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "beta", auto: { enabled: false } } },
          update: {
            updateSchedule: {
              channel: "extended-stable",
              autoEnabled: true,
              install: { kind: "package" },
            },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );

    const channel = row("Release channel").querySelector<HTMLElement & { value: string }>(
      "wa-radio-group",
    );
    expect(channel?.value).toBe("beta");
    expect(
      [...container.querySelectorAll("wa-radio")].map((option) => option.textContent?.trim()),
    ).toEqual(["Stable", "Beta", "Dev"]);
    expect(automaticUpdatesControl().toggle.hasAttribute("disabled")).toBe(false);
  });

  it("lets an admin resume disabled checks while preserving the automatic-update preference", () => {
    const onUpdateChecksChange = vi.fn();
    render(
      renderUpdates(
        createProps({
          configObject: {
            update: { channel: "stable", checkOnStart: false, auto: { enabled: true } },
          },
          update: { updateSchedule: { channel: "stable", autoEnabled: false } },
          onUpdateChecksChange,
        }),
      ),
      container,
    );

    const checks = row("Check for updates").querySelector<HTMLElement & { checked: boolean }>(
      "wa-switch",
    );
    if (!checks) {
      throw new Error("Missing update checks control");
    }
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
      name: "allows dev installs with unknown metadata",
      channel: "dev",
      installKind: "unknown",
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
    {
      name: "allows beta package installs",
      channel: "beta",
      installKind: "package",
      disabled: false,
      description: undefined,
    },
  ] as const)("$name", ({ channel, installKind, disabled, description }) => {
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel, auto: { enabled: false } } },
          update: {
            updateSchedule: {
              channel,
              autoEnabled: false,
              install: { kind: installKind },
            },
          },
        }),
      ),
      container,
    );

    const automatic = automaticUpdatesControl();
    expect(automatic.toggle.hasAttribute("disabled")).toBe(disabled);
    if (description) {
      expect(automatic.row.textContent).toContain(description);
    }
  });

  it("renders the authoritative waiting countdown as a quiet timer", () => {
    const onHoldUpdate = vi.fn(async () => true);
    render(
      renderUpdates(
        createProps({
          update: {
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
                forceAtMs: 762_000,
                updatedAtMs: 1_000,
              },
            },
            updateAvailable: null,
          },
          onHoldUpdate,
        }),
      ),
      container,
    );

    const timer = row("Status").querySelector("[role='timer']");
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Waiting for active work · forced update in 12:41");
    const hold = row("Status").querySelector<HTMLButtonElement>("button");
    expect(hold?.textContent?.trim()).toBe("Hold 1 h");
    hold?.click();
    expect(onHoldUpdate).toHaveBeenCalledOnce();
  });

  it("shows held campaign timing and hides the one-shot hold action", () => {
    render(
      renderUpdates(
        createProps({
          update: {
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
                holdUntilMs: 61_000,
                forceAtMs: 961_000,
                updatedAtMs: 1_000,
              },
            },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain("Update held · resumes in 1:00");
    expect(row("Status").querySelector("button")).toBeNull();

    render(
      renderUpdates(
        createProps({
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
        }),
      ),
      container,
    );
    expect(row("Status").querySelector("button")).toBeNull();
  });

  it("shows truthful Git build, install, and commit ages", () => {
    const installedAtMs = Date.parse("2026-08-08T12:00:00Z");
    const commitAtMs = Date.parse("2026-08-08T10:00:00Z");
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "dev" } },
          nowMs: Date.parse("2026-08-08T14:00:00Z"),
          update: {
            updateSchedule: {
              channel: "dev",
              autoEnabled: false,
              install: {
                kind: "git",
                git: {
                  status: "current",
                  currentSha: "a".repeat(40),
                  commitAtMs,
                  installedAtMs,
                },
              },
            },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );

    expect(row("Installed").querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T12:00:00.000Z",
    );
    expect(row("Installed").textContent).toContain("2h ago");
    expect(row("Last commit").querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T10:00:00.000Z",
    );
    expect(row("Last commit").textContent).toContain("4h ago");

    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "dev" } },
          update: {
            updateSchedule: {
              channel: "dev",
              autoEnabled: false,
              install: { kind: "git", git: { status: "current" } },
            },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );
    expect(row("Installed").textContent).toContain(
      "Unknown · recorded after the next successful update",
    );
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
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "dev" } },
          update: {
            updateSchedule: {
              channel: "dev",
              autoEnabled: false,
              install: { kind: "git", git },
            },
            updateAvailable: null,
          },
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain(label);
    expect(row("Status").querySelector(".settings-status__dot")).toBeNull();
  });

  it("surfaces the latest update failure ahead of passive availability", () => {
    render(
      renderUpdates(
        createProps({
          update: {
            updateStatusBanner: {
              tone: "danger",
              text: "Update error: build-failed. Fix the build error and retry.",
            },
          },
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain(
      "Update error: build-failed. Fix the build error and retry.",
    );
    expect(row("Status").querySelector(".settings-status--danger")).not.toBeNull();
    expect(row("Recovery").textContent).toContain("Retry update");
    expect(row("CLI fallback").textContent).toContain("openclaw triage");
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
    async ({ status, reason, recovery, reconciled }) => {
      const onUpdateNow = vi.fn();
      const onCheckStatus = vi.fn(async () => true);
      render(
        renderUpdates(
          createProps({
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
          }),
        ),
        container,
      );
      document.body.append(container);
      try {
        const view = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-update-run-view",
        )!;
        await view.updateComplete;
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
      } finally {
        container.remove();
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
      render(
        renderUpdates(
          createProps({
            update: {
              updateStatusBanner: projected.banner,
              recordedUpdateAttempt: projected.attempt,
            },
          }),
        ),
        container,
      );

      expect(row("Status").textContent).toContain(reason);
      expect(container.textContent?.includes("Retry update")).toBe(recovery);
      expect(container.textContent?.includes("CLI fallback")).toBe(recovery);
      expect(container.textContent?.includes("openclaw triage")).toBe(recovery);
    },
  );

  it("keeps retry and report as separate actions for one final failure", () => {
    const onReportFailure = vi.fn(async () => undefined);
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
          update: { updateRun: run, reportableUpdateFailureId: run.runId },
          onReportFailure,
        }),
      ),
      container,
    );

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
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
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
        }),
      ),
      container,
    );

    const report = row("Failure report");
    expect(report.textContent).toContain("Review and submit the prefilled issue in your browser.");
    expect(report.textContent).not.toContain("/private/report.md");
    expect(report.querySelector("a")?.getAttribute("href")).toContain("issues/new");
  });

  it("renders an ambiguous submission as pending without a replay link", () => {
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
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
        }),
      ),
      container,
    );

    const report = row("Failure report");
    expect(report.textContent).toContain("may have completed");
    expect(report.querySelector("a")).toBeNull();
  });

  it("renders a definitely unstarted report as retryable rather than ambiguous", () => {
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
          update: {
            updateRun: run,
            reportableUpdateFailureId: run.runId,
            updateFailureReportNotice: {
              attemptId: run.runId,
              result: {
                status: "retryable",
                message: "No issue submission was started; retry this action later.",
              },
            },
          },
        }),
      ),
      container,
    );

    const report = row("Failure report");
    expect(report.textContent).toContain("No GitHub issue submission was started");
    expect(report.textContent).toContain("retry this action later");
    expect(report.textContent).not.toContain("may have completed");
    expect(report.querySelector("a")).toBeNull();
  });

  it("keeps read-only facts visible while locking controls for non-admins", () => {
    render(
      renderUpdates(createProps({ canAdmin: false, canUpdate: false, configBusy: true })),
      container,
    );

    expect(container.querySelector("[role='note']")?.textContent).toContain(
      "Administrator access is required",
    );
    expect(row("Release channel").querySelector("wa-radio-group")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(row("Automatic updates").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(row("Check for updates").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(row("Update now").querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(row("Status").querySelector("button")).toBeNull();
    expect(row("Gateway version").textContent).toContain("2026.8.1");
  });
});
