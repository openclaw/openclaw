import { expect, it } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
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
  expect(resolveSidebarUpdateAttention(context) !== null).toBe(visible);
});

it("keeps explicit dev update progress and errors visible", () => {
  const context = contextWithGitStatus("behind");
  context.overlays.snapshot.updateSchedule!.channel = "dev";
  context.overlays.snapshot.updateAvailable!.channel = "dev";
  context.overlays.snapshot.updateRunning = true;
  expect(resolveSidebarUpdateAttention(context)).not.toBeNull();
  context.overlays.snapshot.updateRunning = false;
  context.overlays.snapshot.updateStatusBanner = { tone: "danger", text: "Update failed" };
  expect(resolveSidebarUpdateAttention(context)).not.toBeNull();
});

it.each(["2026.9.4", "2026.10.1"])("keeps only current failed-run attention on %s", (version) => {
  const context = contextWithGitStatus("current");
  context.overlays.snapshot.updateRun = createUpdateRunFixture({
    status: "failed",
    before: { version: "2026.9.4" },
    finishedAtMs: Date.now(),
  });
  context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    server: { version },
    features: { methods: [] },
  };
  expect(resolveSidebarUpdateAttention(context) !== null).toBe(version === "2026.9.4");
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

  expect(Boolean(resolveSidebarUpdateAttention(context)?.dismissal)).toBe(dismissible);
});
