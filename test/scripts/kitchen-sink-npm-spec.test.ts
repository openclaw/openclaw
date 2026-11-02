import { describe, expect, it } from "vitest";
import {
  BRANCH_KITCHEN_SINK_NPM_VERSION,
  resolveKitchenSinkNpmSpec,
} from "../../scripts/e2e/lib/kitchen-sink-plugin/npm-spec.mts";

describe("Kitchen Sink npm fixture", () => {
  it("uses the branch-recorded version by default", () => {
    expect(BRANCH_KITCHEN_SINK_NPM_VERSION).toBe("0.4.1");
    expect(resolveKitchenSinkNpmSpec({})).toBe("npm:@openclaw/kitchen-sink@0.4.1");
  });

  it("preserves explicit package overrides", () => {
    expect(
      resolveKitchenSinkNpmSpec({ OPENCLAW_KITCHEN_SINK_NPM_SPEC: "npm-pack:/tmp/plugin.tgz" }),
    ).toBe("npm-pack:/tmp/plugin.tgz");
  });
});
