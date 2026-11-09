// Agent selection must not silently change the scope of aggregate status output.
import { expect, it, vi } from "vitest";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const scanStatusJsonFast = vi.hoisted(() => vi.fn());
// mock-isolation: The rejected option must not start config collection or live Gateway probes.
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast }));

it.each([
  [{ agent: "beta" }, "--agent is only valid with --usage"],
  [{ usage: true, agent: "" }, "--agent must not be blank"],
] as const)("rejects invalid agent selection %j before scanning", async (selection, error) => {
  const runtime = createTestRuntime();
  const opts = { ...createStatusGatewayProbeBudget(), ...selection };
  await expect(runStatusJsonCommand({ opts, runtime })).rejects.toMatchObject({
    name: "ExpectedCliError",
    message: error,
  });
  expect(scanStatusJsonFast).not.toHaveBeenCalled();
});
