import { describe, expect, it } from "vitest";
import { resolveIsolatedVitestBuild } from "../../scripts/lib/vitest-isolated-build.mts";

describe("isolated Vitest build selection", () => {
  it.each([
    ...[
      "src/plugins/setup-registry.migrations.test.ts",
      "src/plugins/source-checkout-runtime.test.ts",
    ].map((file) => ({
      args: ["--config", "test/vitest/vitest.unit-fast.config.ts", file],
      expected: { profile: "qaRuntime", privateQa: false },
    })),
    {
      args: ["--config", "test/vitest/vitest.unit-fast.config.ts", "src/polls.test.ts"],
      expected: undefined,
    },
    {
      args: ["src/channels/plugins/contracts/plugin-shape.contract.test.ts"],
      expected: { profile: "qaRuntime", privateQa: true },
    },
    {
      args: [
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
      ],
      expected: { profile: "ciArtifacts", privateQa: true },
    },
    {
      args: [
        "--config",
        "test/vitest/vitest.e2e.config.ts",
        "test/e2e/qa-lab/runtime/node-worker-launch-wire.e2e.test.ts",
        "test/e2e/qa-lab/runtime/skill-library-worker-wire.e2e.test.ts",
      ],
      expected: { profile: "qaRuntime", privateQa: true, declarations: true },
    },
    {
      args: ["--config", "test/custom.config.ts", "src/plugins/source-checkout-runtime.test.ts"],
      expected: undefined,
    },
  ])("selects prerequisites for $args", ({ args, expected }) => {
    expect(resolveIsolatedVitestBuild(["run", ...args], {})).toEqual(expected);
  });
});
