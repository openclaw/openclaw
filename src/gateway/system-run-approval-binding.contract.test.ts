import fs from "node:fs";
import { describe, expect, test } from "vitest";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  type SystemRunApprovalMatchResult,
} from "../infra/system-run-approval-binding.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

type BindingInput = Pick<ExecApprovalRequestPayload, "cwd" | "agentId" | "sessionKey"> & {
  argv: string[];
  env?: Record<string, string>;
};
type FixtureCase = {
  name: string;
  request: Pick<
    ExecApprovalRequestPayload,
    "command" | "commandArgv" | "cwd" | "agentId" | "sessionKey"
  > & { host: string; binding?: BindingInput };
  invoke: {
    argv: string[];
    binding: Required<Pick<BindingInput, "cwd" | "agentId" | "sessionKey">> &
      Pick<BindingInput, "env">;
  };
  expected: { ok: boolean; code?: Extract<SystemRunApprovalMatchResult, { ok: false }>["code"] };
};
const fixture: { cases: FixtureCase[] } = JSON.parse(
  fs.readFileSync(
    new URL("../../test/fixtures/system-run-approval-binding-contract.json", import.meta.url),
    "utf8",
  ),
);

function buildRequestPayload(entry: FixtureCase): ExecApprovalRequestPayload {
  const { binding, ...request } = entry.request;
  return {
    ...request,
    nodeId: "node-1",
    cwd: entry.request.cwd ?? null,
    agentId: entry.request.agentId ?? null,
    sessionKey: entry.request.sessionKey ?? null,
    ...(binding ? { systemRunBinding: buildSystemRunApprovalBinding(binding).binding } : {}),
  };
}

const nonNodeHostCase: FixtureCase = {
  name: "rejects non-node host requests",
  request: {
    host: "gateway",
    command: "echo SAFE",
    binding: { argv: ["echo", "SAFE"] },
  },
  invoke: {
    argv: ["echo", "SAFE"],
    binding: { cwd: null, agentId: null, sessionKey: null },
  },
  expected: { ok: false, code: "APPROVAL_REQUEST_MISMATCH" },
};

describe("system-run approval binding contract fixtures", () => {
  for (const entry of [...fixture.cases, nonNodeHostCase]) {
    test(entry.name, async (testContext) => {
      const approvalManager = createTestApprovalManager(testContext);
      const record = approvalManager.create(buildRequestPayload(entry), 60_000);
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
      if (!entry.expected.ok) {
        if (result.ok) {
          throw new Error("expected approval mismatch");
        }
        expect(result.details?.code).toBe(entry.expected.code);
      }
    });
  }
});
