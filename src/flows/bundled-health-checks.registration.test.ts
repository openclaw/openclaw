import { afterEach, expect, it } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerBundledHealthChecks } from "./bundled-health-checks.js";
import {
  clearHealthChecksForTest,
  getHealthCheck,
  listHealthChecks,
} from "./health-check-registry.js";

afterEach(clearHealthChecksForTest);

it("keeps one real OpenAI retirement check across repeated bundled registration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    clearHealthChecksForTest();
    registerBundledHealthChecks({ cfg: {} });
    const id = "openai/daybreak-alias-retirement";
    const check = getHealthCheck(id);
    if (!check) {
      throw new Error("OpenAI retirement check was not registered");
    }
    registerBundledHealthChecks({ cfg: {} });
    expect(getHealthCheck(id)).toBe(check);
    expect(listHealthChecks().filter((entry) => entry.id === id)).toHaveLength(1);
    const runtime = createTestRuntime();
    expect(await check.detect({ cfg: {}, mode: "lint", runtime })).toEqual([]);
    expect(
      await check.detect({
        cfg: { agents: { defaults: { model: "openai/gpt-daybreak-blue-latest" } } },
        mode: "lint",
        runtime,
      }),
    ).toEqual([expect.objectContaining({ checkId: id, severity: "warning" })]);
  });
});
