import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { AgentParamsSchema } from "./schema/agent.js";

const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;

describe("AgentParamsSchema", () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(AgentParamsSchema);

  it("accepts opaque Paperclip adapter metadata on agent calls", () => {
    expect(
      validate({
        message: "Paperclip wake event for a cloud adapter.",
        sessionKey: "paperclip",
        idempotencyKey: "run-123",
        paperclip: {
          runId: "run-123",
          companyId: "company-123",
          agentId: "agent-123",
          wakeReason: "retry_failed_run",
          issueIds: ["issue-123"],
          workspace: {
            cwd: "/paperclip/instances/default/workspaces/agent-123",
            source: "agent_home",
          },
        },
      }),
    ).toBe(true);
  });

  it("continues rejecting unrelated top-level properties", () => {
    expect(
      validate({
        message: "hello",
        idempotencyKey: "run-123",
        unexpected: { source: "integration" },
      }),
    ).toBe(false);
  });
});
