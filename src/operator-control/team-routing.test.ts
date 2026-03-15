import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { invalidateRegistryCache } from "./agent-registry.js";
import { resolveOperatorReferenceSourcePath } from "./reference-paths.js";
import { resolveOperatorTaskEnvelope } from "./team-routing.js";

async function seedOperatorRegistryFixture(): Promise<void> {
  const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(
    sourcePath,
    [
      "operator_runtime:",
      "  transports:",
      "    delegated_http:",
      "      global_default_alias: tonys-angels",
      "agents:",
      "  - id: raekwon",
      "    name: Raekwon",
      "    specialty: Backend",
      "    triggers: [backend]",
      "  - id: deb",
      "    name: Deb",
      "    specialty: Project Ops",
      "    triggers: [sprint, status, project-ops]",
      "  - id: jeffy",
      "    name: Jeffy",
      "    specialty: Kanban",
      "    triggers: [kanban, board_hygiene_packet]",
      "  - id: tonys-angels",
      "    name: Tony's Angels",
      "    specialty: Marketing",
      "    triggers: [marketing]",
      "  - id: bobby-digital",
      "    name: Bobby Digital",
      "    specialty: Engineering",
      "    triggers: [backend, engineering]",
      "teams:",
      "  - id: execution-fleet",
      "    name: Execution Fleet",
      "    lead: raekwon",
      "    route_via_lead: true",
      "    members: [raekwon]",
      "    dispatch_transport: 2tony-http",
      "  - id: project-ops",
      "    name: Project Ops",
      "    lead: deb",
      "    members: [deb, jeffy]",
      "    dispatch_transport: deb-http",
      "  - id: marketing",
      "    name: Marketing",
      "    lead: tonys-angels",
      "    route_via_lead: true",
      "    members: [tonys-angels]",
      "    dispatch_transport: delegated-http",
      "    dispatch_default_alias: tonys-angels",
      "  - id: engineering",
      "    name: Engineering",
      "    lead: bobby-digital",
      "    route_via_lead: true",
      "    members: [bobby-digital, raekwon]",
      "    dispatch_transport: delegated-http",
      "    dispatch_default_alias: bobby-digital",
      "",
    ].join("\n"),
    "utf8",
  );
  invalidateRegistryCache({ sourcePath });
}

describe("operator team routing", () => {
  beforeEach(async () => {
    await seedOperatorRegistryFixture();
  });

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

  it("resolves marketing work to the delegated transport by default", async () => {
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
      expect(envelope.target.alias).toBe("tonys-angels");
      expect(envelope.execution.transport).toBe("delegated-http");
    });
  });

  it("routes engineering work through Bobby before specialists", async () => {
    await withStateDirEnv("operator-team-routing-engineering-", async () => {
      const envelope = resolveOperatorTaskEnvelope({
        task_id: "task-team-6",
        idempotency_key: "idem-team-6",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend", team_id: "engineering" },
        objective: "Route backend work through Bobby",
        acceptance_criteria: ["engineering routed through Bobby"],
        timeout_s: 600,
      });

      expect(envelope.target.team_id).toBe("engineering");
      expect(envelope.target.alias).toBe("bobby-digital");
      expect(envelope.execution.transport).toBe("delegated-http");
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
