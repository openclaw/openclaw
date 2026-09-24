// Launchd current service tests cover resolving active macOS service labels.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCurrentProcessInsideLaunchdService,
  isCurrentProcessLaunchdServiceLabel,
} from "./launchd-current-service.js";

describe("isCurrentProcessLaunchdServiceLabel", () => {
  it("matches launchd-provided service labels", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(true);
  });

  it("falls back to OpenClaw service markers when XPC_SERVICE_NAME is inherited", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        XPC_SERVICE_NAME: "0",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(true);
  });

  it("does not treat the configured label alone as current service identity", () => {
    // Detached update helper children inherit OPENCLAW_LAUNCHD_LABEL.
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(false);
  });

  it("does not treat unrelated inherited launchd labels as current services", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        XPC_SERVICE_NAME: "0",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(false);
  });
});

const probe = vi.hoisted(() => vi.fn());
const ancestors = vi.hoisted(() => vi.fn<() => Set<number>>());
vi.mock("../infra/restart-stale-pids.js", () => ({ getSelfAndAncestorPidsSync: ancestors }));
vi.mock("./launchd-runtime.js", () => ({
  probeLaunchAgentState: probe,
  resolveLaunchAgentGuiDomain: () => "gui/501",
}));

describe("launchd membership with unavailable process evidence", () => {
  beforeEach(() => {
    probe.mockReset();
    ancestors.mockReset();
  });
  it.each([
    { pids: [900, 901], inside: true },
    { pids: [900, 901, 1], inside: false },
    { pids: [900, 901, 4242], inside: true },
  ])("keeps partial ancestry conservative: $pids", async ({ pids, inside }) => {
    probe.mockResolvedValue({ state: "running", runtime: { pid: 4242 } });
    ancestors.mockReturnValue(new Set(pids));
    expect(
      await isCurrentProcessInsideLaunchdService("ai.openclaw.gateway", {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(inside);
  });
  it.each([{ state: "unknown" }, { state: "running", runtime: {} }])(
    "preserves managed-wrapper protection when launchd reports %j",
    async (result) => {
      probe.mockResolvedValue(result);
      expect(
        await isCurrentProcessInsideLaunchdService("ai.openclaw.gateway", {
          XPC_SERVICE_NAME: "0",
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        }),
      ).toBe(true);
      expect(
        await isCurrentProcessInsideLaunchdService("ai.openclaw.gateway", {
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        }),
      ).toBe(false);
    },
  );
});
