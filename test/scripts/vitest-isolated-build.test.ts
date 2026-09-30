import { describe, expect, it } from "vitest";
import { resolveIsolatedVitestBuild } from "../../scripts/lib/vitest-isolated-build.mts";

describe("isolated Vitest build selection", () => {
  it.each([
    "src/plugins/setup-registry.migrations.test.ts",
    "src/plugins/source-checkout-runtime.test.ts",
  ])("prepares the runtime for the selected cold consumer %s", (file) => {
    expect(
      resolveIsolatedVitestBuild(
        ["run", "--config", "test/vitest/vitest.unit-fast.config.ts", file],
        {},
      ),
    ).toEqual({ profile: "qaRuntime", privateQa: false });
  });

  it("keeps source-only selections free of a runtime build", () => {
    expect(
      resolveIsolatedVitestBuild(
        ["run", "--config", "test/vitest/vitest.unit-fast.config.ts", "src/polls.test.ts"],
        {},
      ),
    ).toBeUndefined();
  });

  it("retains the stronger private-QA prerequisite in the default root", () => {
    expect(
      resolveIsolatedVitestBuild(
        ["run", "src/channels/plugins/contracts/plugin-shape.contract.test.ts"],
        {},
      ),
    ).toEqual({ profile: "qaRuntime", privateQa: true });
  });

  it("retains UI artifact preparation for browser selections", () => {
    expect(
      resolveIsolatedVitestBuild(
        [
          "run",
          "--config",
          "test/vitest/vitest.ui-e2e.config.ts",
          "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
        ],
        {},
      ),
    ).toEqual({ profile: "ciArtifacts", privateQa: true });
  });

  it("leaves custom config prerequisite ownership unchanged", () => {
    expect(
      resolveIsolatedVitestBuild(
        ["run", "--config", "test/custom.config.ts", "src/plugins/source-checkout-runtime.test.ts"],
        {},
      ),
    ).toBeUndefined();
  });
});
