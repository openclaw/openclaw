import { describe, expect, it, vi } from "vitest";
import { PR_PROTECTED_RUNTIME_TEST_FILES } from "../../scripts/lib/ci-proof-test-inventory.mts";
import {
  createChangedNodeTestShards,
  fallbackGroups,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

describe("CI changed Node test plan", () => {
  it.each(["pnpm-lock.yaml", "test/vitest/vitest.unknown-owner.config.ts"])(
    "keeps %s bounded to its direct consumers",
    (hub) => {
      const config = "test/vitest/vitest.commands.config.ts";
      const onFallback = vi.fn();
      const bounded = createChangedNodeTestShards([hub], { onFallback });
      expect(bounded).not.toBeNull();
      const configOwners = fallbackGroups(bounded ?? []).filter((group) =>
        group.configs.includes(config),
      );
      if (hub === "pnpm-lock.yaml") {
        expect(configOwners.length).toBeGreaterThan(0);
        expect(
          configOwners
            .flatMap((group) => group.includePatterns ?? [])
            .every((file) => PR_PROTECTED_RUNTIME_TEST_FILES.includes(file)),
        ).toBe(true);
      } else {
        expect(configOwners).toHaveLength(0);
      }
      expect(selectedFiles(bounded)).not.toContain("src/infra/device-bootstrap.test.ts");
      expect(onFallback).not.toHaveBeenCalled();
    },
  );
});
