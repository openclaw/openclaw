import { expect, it } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createFailedVerificationRun } from "../test-helpers/update-run.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

function contextWithGitStatus(status: "behind" | "current" | "unavailable"): ApplicationContext {
  const git =
    status === "current"
      ? { status }
      : status === "behind"
        ? { status, commitsBehind: 50 }
        : { status, reason: "fetch-failed" };
  return {
    gateway: { snapshot: { phase: "connected" } },
    overlays: {
      snapshot: {
        updateAvailable: {
          currentVersion: "2026.9.2",
          latestVersion: "2026.9.3",
          channel: "stable",
          commitsBehind: 246,
        },
        updateSchedule: {
          channel: "stable",
          autoEnabled: false,
          install: { kind: "git", git },
          target: {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "abc1234def",
            commitsBehind: 246,
          },
        },
      },
    },
  } as unknown as ApplicationContext;
}

it.each([
  ["stable", "stable", "behind", true],
  ["beta", "beta", "behind", true],
  ["dev", "dev", "behind", false],
  ["extended-stable", "extended-stable", "behind", false],
  ["unknown", "unknown", "behind", false],
  ["stable", "dev", "behind", false],
  ["stable", null, "behind", true],
  ["dev", null, "behind", false],
  ["stable", "stable", "current", false],
  ["stable", "stable", "unavailable", true],
] as const)("eligibility %s / %s / %s", (advertised, selected, status, visible) => {
  const context = contextWithGitStatus(status);
  const snapshot = context.overlays.snapshot;
  snapshot.updateAvailable!.channel = advertised;
  snapshot.updateSchedule =
    selected === null ? null : { ...snapshot.updateSchedule!, channel: selected };
  expect(resolveSidebarUpdateAttention(context).length !== 0).toBe(visible);
});

it("keeps explicit dev update progress and errors visible", () => {
  const context = contextWithGitStatus("behind");
  context.overlays.snapshot.updateSchedule!.channel = "dev";
  context.overlays.snapshot.updateAvailable!.channel = "dev";
  context.overlays.snapshot.updateRunning = true;
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(1);
  context.overlays.snapshot.updateRunning = false;
  context.overlays.snapshot.updateStatusBanner = { tone: "danger", text: "Update failed" };
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(1);
});

it("retains the same failed outcome across reconnect until acknowledged or 24 hours old", () => {
  const context = contextWithGitStatus("current");
  const snapshot = context.overlays.snapshot;
  const run = createFailedVerificationRun();
  snapshot.updateRun = run;
  snapshot.updateStatusBanner = { tone: "danger", text: "Update verification failed" };
  context.gateway.snapshot.client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    server: { version: "1.0.0", buildId: "before-build" },
    auth: { role: "operator", scopes: ["operator.admin"] },
    features: { methods: ["update.run"] },
  };
  const dismissal = { kind: "updateAvailable", signature: JSON.stringify(["run", run.runId]) };
  expect(resolveSidebarUpdateAttention(context)[0]).toMatchObject({ dismissal, severity: "error" });
  context.gateway.snapshot.hello.server!.buildId = "target-build";
  expect(resolveSidebarUpdateAttention(context)[0]).toMatchObject({
    dismissal,
    severity: "warning",
    requiresAction: false,
  });
  snapshot.updateRunAcknowledged = true;
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(0);
  snapshot.updateRunAcknowledged = false;
  snapshot.updateRun = { ...run, finishedAtMs: Date.now() - 24 * 60 * 60 * 1000 };
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(0);
});

it.each([
  ["stable admin update", "operator.admin", false, true],
  ["read-only update", "operator.read", false, false],
  ["forced update", "operator.admin", true, false],
] as const)("projects %s with explicit dismissal policy", (_name, scope, forced, dismissible) => {
  const context = contextWithGitStatus("behind");
  context.gateway.snapshot.client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    server: { bootId: "boot-a" },
    auth: { role: "operator", scopes: [scope] },
    features: { methods: ["update.run"] },
  };
  context.overlays.snapshot.updateRunning = forced;

  expect(Boolean(resolveSidebarUpdateAttention(context)[0]?.dismissal)).toBe(dismissible);
});

it("hides an unhydrated campaign only while update status can be polled", () => {
  const context = contextWithGitStatus("behind");
  const snapshot = context.overlays.snapshot;
  snapshot.updateSchedule!.campaign = {
    id: "waiting",
    state: "waiting-for-idle",
    announcedAtMs: 0,
    forceAtMs: 1,
    updatedAtMs: 0,
  };
  snapshot.updateCampaignStatusHydrated = false;
  const hello = {
    type: "hello-ok" as const,
    protocol: 1,
    auth: { role: "operator", scopes: ["operator.admin"] },
    features: { methods: ["update.status"] },
  };
  context.gateway.snapshot.client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  context.gateway.snapshot.hello = hello;
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(0);
  hello.auth.scopes = ["operator.read"];
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(1);
  hello.auth.scopes = ["operator.admin"];
  snapshot.updateCampaignStatusHydrated = true;
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(1);
});

it("keeps restart reconciliation visible after update metadata clears", () => {
  const context = contextWithGitStatus("current");
  const snapshot = context.overlays.snapshot;
  snapshot.updateAvailable = null;
  snapshot.updateSchedule = null;
  snapshot.updateReconciliationPending = true;
  expect(resolveSidebarUpdateAttention(context)).toHaveLength(1);
});
