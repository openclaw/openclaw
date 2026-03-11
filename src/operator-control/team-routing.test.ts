import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resolveOperatorTaskEnvelope } from "./team-routing.js";

describe("operator team routing", () => {
  it("resolves execution-fleet backend work to raekwon", async () => {
    await withStateDirEnv("operator-team-routing-exec-", async () => {
      const envelope = resolveOperatorTaskEnvelope({
        task_id: "task-team-1",
        idempotency_key: "idem-team-1",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend", team_id: "execution-fleet" },
        objective: "Route backend task",
        acceptance_criteria: ["alias resolved"],
        timeout_s: 600,
      });

      expect(envelope.target.team_id).toBe("execution-fleet");
      expect(envelope.target.alias).toBe("raekwon");
      expect(envelope.execution.transport).toBe("2tony-http");
    });
  });

  it("resolves project-ops work to deb and defaults to deb-http", async () => {
    await withStateDirEnv("operator-team-routing-deb-", async () => {
      const envelope = resolveOperatorTaskEnvelope({
        task_id: "task-team-2",
        idempotency_key: "idem-team-2",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "sprint", team_id: "project-ops" },
        objective: "Update sprint board",
        acceptance_criteria: ["project ops routed"],
        timeout_s: 600,
      });

      expect(envelope.target.alias).toBe("deb");
      expect(envelope.execution.transport).toBe("deb-http");
    });
  });

  it("preserves explicit transport overrides for team-targeted tasks", async () => {
    await withStateDirEnv("operator-team-routing-manual-", async () => {
      const envelope = resolveOperatorTaskEnvelope({
        task_id: "task-team-3",
        idempotency_key: "idem-team-3",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "marketing", team_id: "marketing" },
        objective: "Hold for later Angela contract",
        acceptance_criteria: ["manual override preserved"],
        timeout_s: 600,
        execution: {
          transport: "manual",
          runtime: "acpx",
          durable: true,
        },
      });

      expect(envelope.execution.transport).toBe("manual");
    });
  });

  it("resolves marketing work to the Angela transport by default", async () => {
    await withStateDirEnv("operator-team-routing-angela-", async () => {
      const envelope = resolveOperatorTaskEnvelope({
        task_id: "task-team-5",
        idempotency_key: "idem-team-5",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "marketing", team_id: "marketing" },
        objective: "Route investor narrative work",
        acceptance_criteria: ["marketing transport resolved"],
        timeout_s: 600,
      });

      expect(envelope.target.team_id).toBe("marketing");
      expect(envelope.execution.transport).toBe("angela-http");
    });
  });

  it("rejects aliases outside the selected team", async () => {
    await withStateDirEnv("operator-team-routing-invalid-alias-", async () => {
      expect(() =>
        resolveOperatorTaskEnvelope({
          task_id: "task-team-4",
          idempotency_key: "idem-team-4",
          requester: { id: "tonya", kind: "operator" },
          target: { capability: "backend", team_id: "project-ops", alias: "raekwon" },
          objective: "Invalid alias",
          acceptance_criteria: ["validation fails"],
          timeout_s: 600,
        }),
      ).toThrow("target alias raekwon is not a member of team project-ops");
    });
  });
});
