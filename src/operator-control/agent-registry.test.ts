import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { compileOperatorAgentRegistry } from "./agent-registry.js";

describe("compileOperatorAgentRegistry", () => {
  it("compiles agents.yaml into a stable registry artifact", async () => {
    await withStateDirEnv("operator-registry-", async ({ stateDir }) => {
      await withTempDir("operator-registry-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "agents:",
            "  - id: tonya",
            "    name: Tonya",
            "    specialty: Control plane",
            "    model: codex",
            "    triggers: [operator, orchestration]",
            "  - id: deb",
            "    name: Deb",
            "    specialty: Project board",
            "teams:",
            "  - id: control-plane",
            "    name: Control Plane",
            "    lead: tonya",
            "    members: [tonya]",
            "  - id: project-ops",
            "    name: Project Ops",
            "    lead: deb",
            "    members: [deb]",
            "    dispatch_transport: deb-http",
            "    dispatch_endpoint_env: OPENCLAW_OPERATOR_DEB_URL",
            "    dispatch_path: /update",
            "    dispatch_auth_scheme: bearer",
            "    dispatch_auth_env: OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
            "skill_ownership:",
            "  - skill: /workspace/skills/acpx-orchestration/SKILL.md",
            "    owner: tonya",
            "    status: active-standalone",
            "pipeline_order:",
            "  - tonya",
            "k8s_cluster:",
            "  - id: tonya",
            "    name: Tonya",
            "    role: primary operator",
            "    namespace: agents",
            "    status: deployed",
            "  - id: deb-pod",
            "    name: Deb",
            "    role: kanban",
            "    namespace: agents",
            "    status: deployed",
            "",
          ].join("\n"),
          "utf8",
        );

        const compiled = compileOperatorAgentRegistry({ sourcePath });

        expect(compiled.schema).toBe("OperatorAgentRegistryV1");
        expect(compiled.agentCount).toBe(2);
        expect(compiled.teamCount).toBe(2);
        expect(compiled.agents[0]).toMatchObject({
          id: "tonya",
          name: "Tonya",
          role: "Control plane",
          specialty: "Control plane",
          triggers: ["operator", "orchestration"],
          teams: ["control-plane"],
        });
        expect(compiled.teams[1]).toMatchObject({
          id: "project-ops",
          lead: "deb",
          members: ["deb"],
          dispatchTransport: "deb-http",
          dispatchEndpointEnv: "OPENCLAW_OPERATOR_DEB_URL",
          dispatchPath: "/update",
          dispatchAuthScheme: "bearer",
          dispatchAuthEnv: "OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
        });
        expect(compiled.pipelineOrder).toEqual(["tonya"]);
        expect(compiled.identities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "tonya",
              kind: "agent",
              name: "Tonya",
              role: "Control plane",
              teamIds: ["control-plane"],
              leadTeamIds: ["control-plane"],
            }),
            expect.objectContaining({
              id: "deb-pod",
              kind: "runtime",
              name: "Deb",
              role: "kanban",
              teamIds: [],
              leadTeamIds: [],
            }),
          ]),
        );

        const artifactPath = path.join(stateDir, "mission-control", "operator-agent-registry.json");
        const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as {
          sourceHash?: string;
          identities?: unknown[];
        };
        expect(artifact.sourceHash).toBe(compiled.sourceHash);
        expect(Array.isArray(artifact.identities)).toBe(true);
      });
    });
  });

  it("rejects unknown skill owners referenced by skill_ownership", async () => {
    await withStateDirEnv("operator-registry-invalid-", async () => {
      await withTempDir("operator-registry-invalid-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "agents:",
            "  - id: tonya",
            "    name: Tonya",
            "skill_ownership:",
            "  - skill: /workspace/skills/acpx-orchestration/SKILL.md",
            "    owner: ghostface",
            "",
          ].join("\n"),
          "utf8",
        );

        expect(() => compileOperatorAgentRegistry({ sourcePath })).toThrow(
          "skill_ownership references unknown owner: ghostface",
        );
      });
    });
  });

  it("rejects teams that reference unknown members", async () => {
    await withStateDirEnv("operator-registry-invalid-team-", async () => {
      await withTempDir("operator-registry-invalid-team-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "agents:",
            "  - id: tonya",
            "    name: Tonya",
            "teams:",
            "  - id: control-plane",
            "    name: Control Plane",
            "    lead: tonya",
            "    members: [tonya, deb]",
            "",
          ].join("\n"),
          "utf8",
        );

        expect(() => compileOperatorAgentRegistry({ sourcePath })).toThrow(
          "team references unknown member: deb",
        );
      });
    });
  });
});
