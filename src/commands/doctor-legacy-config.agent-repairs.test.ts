import { describe, expect, it } from "vitest";
import { useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";

describe("legacy agent config repairs", () => {
  useDoctorLegacyConfigFixture();

  it.each(["entries", "list"] as const)(
    "removes null workspace values from agents.%s",
    async (kind) => {
      const { normalizeCompatibilityConfigValues } =
        await import("./doctor/shared/legacy-config-core-migrate.js");
      const entries = {
        main: { workspace: null },
        beta: { workspace: "/beta" },
        gamma: {},
      };
      const res = normalizeCompatibilityConfigValues({
        agents: {
          [kind]: kind === "entries" ? entries : Object.values(entries),
        },
      });

      expect(res.config.agents?.[kind]).toEqual(
        kind === "entries"
          ? { main: {}, beta: { workspace: "/beta" }, gamma: {} }
          : [{}, { workspace: "/beta" }, {}],
      );
      expect(res.changes).toContain(`Removed null workspace value from agents.${kind} entry.`);
    },
  );

  it("removes invalid heartbeat active-hours windows so saved config can load", async () => {
    const { normalizeCompatibilityConfigValues } =
      await import("./doctor/shared/legacy-config-core-migrate.js");
    const { validateConfigObject } = await import("../config/validation.js");
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            activeHours: { start: "99:99", end: "17:00" },
          },
        },
        entries: {
          ops: {
            heartbeat: {
              prompt: "Check alerts",
              activeHours: { start: "09:00", end: "not-a-time" },
            },
          },
        },
      },
    });

    expect(res.config.agents?.defaults?.heartbeat).toEqual({ every: "30m" });
    expect(res.config.agents?.entries?.ops?.heartbeat).toEqual({ prompt: "Check alerts" });
    expect(res.changes).toContain(
      "Removed invalid agents.defaults.heartbeat.activeHours; heartbeats will use unrestricted hours until it is reconfigured.",
    );
    expect(res.changes).toContain(
      "Removed invalid agents.entries.ops.heartbeat.activeHours; heartbeats will use unrestricted hours until it is reconfigured.",
    );
    expect(validateConfigObject(res.config).ok).toBe(true);
  });
});
