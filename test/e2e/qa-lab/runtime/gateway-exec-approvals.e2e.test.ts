import { it } from "vitest";
import { installGatewayTestHooks } from "../../../../src/gateway/test-helpers.js";
import { runApprovalProof } from "./gateway-approvals.test-support.js";

installGatewayTestHooks({ scope: "suite" });

it("protects policy snapshots and resolves a pending request from another reviewer", async ({
  onTestFinished,
}) => {
  await runApprovalProof("exec", onTestFinished);
}, 120_000);
