import { it } from "vitest";
import { installGatewayTestHooks } from "../../../../src/gateway/test-helpers.js";
import { runApprovalProof } from "./gateway-approvals.test-support.js";

installGatewayTestHooks({ scope: "suite" });

it("delivers a generated request to a distinct reviewer and resolves one terminal decision", async ({
  onTestFinished,
}) => {
  await runApprovalProof("plugin", onTestFinished);
}, 120_000);
