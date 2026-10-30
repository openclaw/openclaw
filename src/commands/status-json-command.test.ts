// Agent selection must not silently change the scope of aggregate status output.
import { expect, it, vi } from "vitest";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const scanStatusJsonFast = vi.hoisted(() => vi.fn());
// mock-isolation: The rejected option must not start config collection or live Gateway probes.
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast }));

it("rejects --agent when usage is not requested", async () => {
  await expect(
    runStatusJsonCommand({
      opts: { ...createStatusGatewayProbeBudget(), agent: "beta" },
      runtime: createTestRuntime(),
    }),
  ).rejects.toThrow("--agent is only valid with --usage");
  expect(scanStatusJsonFast).not.toHaveBeenCalled();
});
