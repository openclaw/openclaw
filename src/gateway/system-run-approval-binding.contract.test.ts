import { describe, expect, test } from "vitest";
import fixture from "../../test/fixtures/system-run-approval-binding-contract.json" with { type: "json" };
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

const matchingCase = fixture.cases[0]!;
const nonNodeHostCase: (typeof fixture.cases)[number] = {
  ...matchingCase,
  name: "rejects non-node host requests",
  request: { ...matchingCase.request, host: "gateway" },
  expected: { ok: false, code: "APPROVAL_REQUEST_MISMATCH" },
};

describe("system-run approval binding contract fixtures", () => {
  for (const entry of [...fixture.cases, nonNodeHostCase]) {
    test(entry.name, async (testContext) => {
      const approvalManager = createTestApprovalManager(testContext);
      const { binding, ...request } = entry.request;
      const record = approvalManager.create(
        {
          ...request,
          nodeId: "node-1",
          cwd: null,
          agentId: null,
          sessionKey: null,
          ...(binding ? { systemRunBinding: buildSystemRunApprovalBinding(binding).binding } : {}),
        },
        60_000,
      );
      record.requestedByDeviceId = "contract-device";
      await approvalManager.register(record, 60_000);
      expect(await approvalManager.resolve(record.id, "allow-once", "operator")).toBe(true);
      const result = await sanitizeSystemRunParamsForForwarding({
        nodeId: "node-1",
        client: { connect: { device: { id: "contract-device" } } },
        rawParams: {
          command: entry.invoke.argv,
          ...entry.invoke.binding,
          approved: true,
          runId: record.id,
        },
        execApprovalManager: approvalManager,
      });

      expect(result.ok).toBe(entry.expected.ok);
      if (!result.ok) {
        expect(result.details?.code).toBe(entry.expected.code);
      }
    });
  }
});
