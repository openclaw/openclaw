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
});
