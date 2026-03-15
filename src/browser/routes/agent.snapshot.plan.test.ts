import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { resolveSnapshotPlan } from "./agent.snapshot.plan.js";

describe("resolveSnapshotPlan", () => {
  it("defaults extension relay snapshots to aria when format is omitted", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        relay: { driver: "extension", cdpUrl: "http://127.0.0.1:18792", color: "#0066CC" },
      },
    });
    const profile = resolveProfile(resolved, "relay");
    expect(profile).toBeTruthy();
    expect(profile?.driver).toBe("extension");

    const plan = resolveSnapshotPlan({
      profile: profile as NonNullable<typeof profile>,
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("aria");
  });

  it("keeps ai snapshots for managed browsers when Playwright is available", () => {
    const resolved = resolveBrowserConfig({});
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile).toBeTruthy();

    const plan = resolveSnapshotPlan({
      profile: profile as NonNullable<typeof profile>,
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });
});
