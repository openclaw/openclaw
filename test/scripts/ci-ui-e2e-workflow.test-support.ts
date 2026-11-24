import { expect, it } from "vitest";
import type { NativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import {
  assertControlUiE2eOwnership,
  assertRealGatewayWorkflowSelection,
} from "./ci-ui-e2e-ownership.test-support.js";
import {
  readCiWorkflow,
  requiredWorkflowStep,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

export function registerControlUiE2eWorkflowTests(
  makeTempDirectory: (prefix: string) => string,
  parser: NativeTypeScriptParser,
): void {
  it("keeps private Control UI servers and resource-sensitive files under one serial owner", async () => {
    await assertControlUiE2eOwnership(makeTempDirectory, parser);
  });

  it("restores shared build content while retaining private real-Gateway preparation", () => {
    const job = readCiWorkflow().jobs["checks-ui-e2e-real-gateway"];
    const setup = requiredWorkflowStep(job.steps, "Setup Node environment");
    const build = requiredWorkflowStep(
      job.steps,
      "Build runtime and Control UI artifacts for real-Gateway tests",
    );
    expect(setup.with?.["build-all-cache-scope"]).toBe("full");
    expect(job.needs).toEqual(["preflight"]);
    expect(build.run).toBe("pnpm build");
    expect(build.env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(build.env?.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe("1");
    expect(job.steps.some((step: WorkflowStep) => step.name === "Save build-all cache")).toBe(
      false,
    );
  });

  it.each([
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: false },
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: true },
    { frozen: false, prebuilt: true, childExit: 0, releaseTier: false, sharded: false },
    { frozen: true, prebuilt: true, childExit: 0 },
    { frozen: true, prebuilt: false, childExit: 0 },
    { frozen: false, prebuilt: false, childExit: 0 },
  ])("selects the real-Gateway tier without retrying failures: %j", async (options) => {
    await assertRealGatewayWorkflowSelection(makeTempDirectory, options);
  });
}
