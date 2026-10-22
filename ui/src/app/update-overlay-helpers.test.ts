import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
// @vitest-environment node
// Control UI tests cover localized update and recovery status copy.
import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateScheduleState } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { client } from "./overlays-access.test-support.ts";
import {
  createUpdateStatusRefresher,
  projectUpdateSentinel,
  projectUpdateStatusResponse,
  resolveUpdateStatusBanner,
  resolveUpdateStatusCheckBanner,
} from "./update-overlay-helpers.ts";
import {
  formatUpdateCampaignLabel,
  projectConnectedUpdateSnapshot,
} from "./update-schedule-projection.ts";

it("awaits status projection and retires a refresh whose authority changes while projecting", async () => {
  const entered = createDeferred();
  const pending = createDeferred();
  let current = true;
  let published = false;
  const gatewayClient = client(async () => ({}));
  const refresh = createUpdateStatusRefresher({
    getClient: () => gatewayClient,
    getEpoch: () => 1,
    getAuthorization: () => undefined,
    canRefresh: () => current,
    isCurrent: () => current,
    onRefreshing: () => {},
    onStatus: async (_response, isCurrent) => {
      entered.resolve();
      await pending.promise;
      published = isCurrent();
    },
    onError: () => {},
  });
  const result = refresh("background");
  await entered.promise;
  current = false;
  pending.resolve();
  await expect(result).resolves.toBe(false);
  expect(published).toBe(false);
});

it("reports a failed status projection without completing the refresh", async () => {
  const error = new Error("Update report could not load");
  const onError = vi.fn();
  const gatewayClient = client(async () => ({}));
  const refresh = createUpdateStatusRefresher({
    getClient: () => gatewayClient,
    getEpoch: () => 1,
    getAuthorization: () => undefined,
    canRefresh: () => true,
    isCurrent: () => true,
    onRefreshing: () => {},
    onStatus: async () => {
      throw error;
    },
    onError,
  });
  await expect(refresh("completion")).resolves.toBe(false);
  expect(onError).toHaveBeenLastCalledWith(error, "completion");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("update schedule hydration", () => {
  it("hydrates git availability and a held campaign from the Gateway snapshot", () => {
    const updateSchedule = {
      channel: "dev",
      autoEnabled: true,
      install: {
        kind: "git",
        git: {
          status: "behind",
          currentSha: "a".repeat(40),
          upstreamSha: "b".repeat(40),
          repositoryUrl: "https://github.com/example/openclaw",
          commitAtMs: 1_000,
          installedAtMs: 2_000,
          commitsBehind: 3,
        },
      },
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "b".repeat(40),
        commitsBehind: 3,
      },
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 1_000,
        holdUntilMs: 3_601_000,
        forceAtMs: 4_501_000,
        updatedAtMs: 2_000,
      },
    } as const;
    const updateAvailable = {
      currentVersion: "2026.8.1",
      latestVersion: "2026.8.1",
      channel: "dev",
      currentSha: "a".repeat(40),
      upstreamRef: "origin/main",
      upstreamSha: "b".repeat(40),
      repositoryUrl: "https://github.com/example/openclaw",
      commitsBehind: 3,
      commits: [
        { sha: "b0b0b0b", subject: "Improve update scheduling" },
        { sha: "a0a0a0a", subject: "Tighten update checks" },
      ],
    };
    const hello = { snapshot: { updateAvailable, updateSchedule } } as GatewayHelloOk;

    const projected = projectConnectedUpdateSnapshot(
      {
        updateAvailable: null,
        updateSchedule: null,
        heldUpdateCampaignId: null,
        updateCampaignStatusHydrated: false,
      },
      hello,
    );
    expect(projected).toEqual({
      updateAvailable,
      updateSchedule,
      heldUpdateCampaignId: "campaign-1",
      updateCampaignStatusHydrated: false,
    });
  });

  it("formats countdown deadlines with a stable minutes-and-seconds shape", () => {
    const schedule = {
      channel: "stable",
      autoEnabled: true,
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 0,
        forceAtMs: 55_000,
        updatedAtMs: 0,
      },
    } as const;

    const label = (
      campaign: Partial<NonNullable<UpdateScheduleState["campaign"]>> = {},
      now = 1_000,
    ) =>
      formatUpdateCampaignLabel(
        { ...schedule, campaign: { ...schedule.campaign, ...campaign } },
        now,
      );
    expect(label()).toBe("Waiting for active work · forced update in 0:54");
    expect(label({ state: "countdown", applyAtMs: 762_000 })).toBe("Updating in 12:41");
    expect(label({}, 56_000)).toBe("Waiting for active work · forced update in 0:00");
    expect(label({ holdUntilMs: 762_000 })).toBe("Update held · resumes in 12:41");
    expect(label({ state: "applying", holdUntilMs: 762_000 })).toBe("Applying update…");
  });
});

describe("update status localization", () => {
  it("keeps external supervisor refusals visible without launching failure triage", () => {
    const projected = projectUpdateSentinel({
      kind: "update",
      status: "skipped",
      ts: 123,
      stats: { reason: "external-supervisor-update-required" },
    });

    expect(projected?.banner?.tone).toBe("warn");
    expect(projected?.banner?.text).toContain("managed by an external supervisor");
    expect(projected?.banner?.text).toContain("Use your server or deployment's update workflow");
    expect(projected?.banner?.text).not.toContain("openclaw triage");
    expect(projected?.attempt?.reason).toBe("external-supervisor-update-required");
    expect(projected?.failure).toBeNull();
  });

  it("distinguishes a failed status check from a failed update", () => {
    const error = "gateway request timed out after 5000ms: update.status";
    expect(resolveUpdateStatusCheckBanner(new Error(error))).toEqual({
      tone: "warn",
      text: `Could not check for updates: ${error}`,
    });
    expect(resolveUpdateStatusBanner({ status: "error", reason: "build-failed" })).toMatchObject({
      tone: "danger",
      text: expect.stringContaining("Update error: build-failed"),
    });
  });

  it("projects the recorded update attempt without inferring from localized text", () => {
    const projected = projectUpdateStatusResponse(
      {
        sentinel: {
          kind: "update",
          status: "error",
          ts: 123,
          stats: {
            mode: "git",
            reason: "build-failed",
            before: { sha: "before" },
            after: { sha: "after" },
            steps: [
              {
                name: "build",
                log: { exitCode: 1, stderrTail: "first line\nType check failed" },
              },
            ],
          },
        },
      },
      {
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        heldUpdateCampaignId: null,
      },
    );

    expect(projected.recordedUpdateAttempt).toEqual({
      timestampMs: 123,
      status: "error",
      reason: "build-failed",
      installKind: "git",
      beforeVersion: null,
      beforeSha: "before",
      afterVersion: null,
      afterSha: "after",
      failure: { step: "build", detail: "Type check failed" },
    });
  });

  it.each([
    { reason: "dirty", key: "dirty", guidance: "Commit or stash changes, then retry." },
    {
      reason: "managed-service-handoff-unavailable",
      key: "managedServiceHandoffUnavailable",
      guidance:
        "Stop the foreground Gateway, run `openclaw update`, then launch it again. For automatic updates, install a managed Gateway service.",
    },
  ])("localizes known update failure guidance for $reason", ({ reason, key, guidance }) => {
    const translate = vi.spyOn(i18n, "t");

    expect(resolveUpdateStatusBanner({ status: "skipped", reason })).toEqual({
      tone: "warn",
      text: `Update skipped: ${reason}. ${guidance}`,
    });
    expect(translate).toHaveBeenCalledWith(`updates.failureReasons.${key}`, undefined);
    expect(translate).toHaveBeenCalledWith("updates.status", {
      status: "skipped",
      reason,
      guidance,
    });
  });

  it("names the recorded cause instead of the reason slug when a retained step failed", () => {
    expect(
      projectUpdateSentinel({
        kind: "update",
        status: "error",
        ts: 1_000,
        stats: {
          reason: "deps-install-failed",
          steps: [
            { name: "fetch", log: { exitCode: 0, stderrTail: "done" } },
            {
              name: "install",
              log: {
                exitCode: 1,
                stderrTail: "Progress: resolved 1\nENOSPC: no space left on device, write",
              },
            },
          ],
        },
      })?.banner,
    ).toEqual({
      tone: "danger",
      text: "The update failed at install: ENOSPC: no space left on device, write. Dependency install failed. Fix the install error and retry. If Ask OpenClaw is unavailable, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair. Diagnose the cause before retrying.",
    });
  });

  it.each(["stderrTail", "stdoutTail"])(
    "redacts credentials in %s before shortening the recorded cause",
    (stream) => {
      const password = "synthetic-password-value";
      const prefix = "npm ERR! fetch failed ";
      const userinfo = `https://build:${password}`;
      const line = `${prefix}${"x".repeat(180 - prefix.length - userinfo.length - 1)} ${userinfo}@registry.example.test/package`;
      const projected = projectUpdateStatusResponse(
        {
          sentinel: {
            kind: "update",
            status: "error",
            ts: 1_000,
            stats: {
              reason: "global-install-failed",
              steps: [{ name: "global update", log: { exitCode: 1, [stream]: line } }],
            },
          },
        },
        { updateStatusBanner: null, recordedUpdateAttempt: null, heldUpdateCampaignId: null },
      );

      const detail = projected.failure?.attempt?.failure?.detail;
      expect(detail).toContain(prefix);
      expect(detail).not.toContain(password);
      expect(detail?.length).toBeLessThanOrEqual(180);
      expect(projected.updateStatusBanner?.text).not.toContain(password);
    },
  );

  it.each(["disk-read-only", "constructor", "__proto__", "toString"])(
    "preserves unknown status %s inside localized fallback guidance",
    (reason) => {
      const translate = vi.spyOn(i18n, "t");

      expect(resolveUpdateStatusBanner({ status: "error", reason })).toEqual({
        tone: "danger",
        text: `Update error: ${reason}. See the gateway logs for the exact failure and retry once the cause is fixed.`,
      });
      expect(translate).toHaveBeenCalledWith("updates.failureReasons.default", undefined);
    },
  );
});
