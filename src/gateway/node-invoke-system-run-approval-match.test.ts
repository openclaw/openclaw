import { describe, expect, test } from "vitest";
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { evaluateSystemRunApprovalMatch } from "./node-invoke-system-run-approval-match.js";

const binding = { cwd: null, agentId: null, sessionKey: null };

describe("evaluateSystemRunApprovalMatch", () => {
  test("rejects argv mismatch in v1 object", () => {
    expect(
      evaluateSystemRunApprovalMatch({
        argv: ["echo", "SAFE"],
        request: {
          host: "node",
          command: "echo SAFE",
          systemRunBinding: buildSystemRunApprovalBinding({ argv: ["echo SAFE"], ...binding })
            .binding,
        },
        binding,
      }),
    ).toMatchObject({ ok: false, code: "APPROVAL_REQUEST_MISMATCH" });
  });

  test("rejects non-node host requests", () => {
    expect(
      evaluateSystemRunApprovalMatch({
        argv: ["echo", "SAFE"],
        request: {
          host: "gateway",
          command: "echo SAFE",
          systemRunBinding: buildSystemRunApprovalBinding({ argv: ["echo", "SAFE"], ...binding })
            .binding,
        },
        binding,
      }),
    ).toMatchObject({ ok: false, code: "APPROVAL_REQUEST_MISMATCH" });
  });
});
