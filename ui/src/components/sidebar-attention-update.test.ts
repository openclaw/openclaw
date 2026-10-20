import { describe, expect, it } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
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
        updateRunning: false,
        updateReconciliationPending: false,
        updateStatusBanner: null,
      },
    },
  } as unknown as ApplicationContext;
}

describe("update attention", () => {
  it.each(["stable", "beta", "dev", "extended-stable", "unknown"])(
    "notifies only release-channel subscribers (%s)",
    (channel) => {
      const context = contextWithGitStatus("behind");
      context.overlays.snapshot.updateAvailable!.channel = channel;
      context.overlays.snapshot.updateSchedule!.channel = channel;
      expect(resolveSidebarUpdateAttention(context) !== null).toBe(
        channel === "stable" || channel === "beta",
      );
    },
  );

  it("uses the selected dev channel instead of stale stable availability", () => {
    const context = contextWithGitStatus("behind");
    context.overlays.snapshot.updateSchedule!.channel = "dev";
    expect(resolveSidebarUpdateAttention(context)).toBeNull();
  });

  it("uses the advertised release channel when the schedule is not available", () => {
    const context = contextWithGitStatus("behind");
    context.overlays.snapshot.updateSchedule = null;
    expect(resolveSidebarUpdateAttention(context)).not.toBeNull();
    context.overlays.snapshot.updateAvailable!.channel = "dev";
    expect(resolveSidebarUpdateAttention(context)).toBeNull();
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

  it.each([
    ["current", false],
    ["behind", true],
    ["unavailable", true],
  ] as const)("sets Inbox presence after a %s comparison", (status, present) => {
    expect(resolveSidebarUpdateAttention(contextWithGitStatus(status)) !== null).toBe(present);
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
});
