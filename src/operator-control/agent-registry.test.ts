import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  compileOperatorAgentRegistry,
  invalidateRegistryCache,
  resolveOperatorDelegatedDefaultAlias,
} from "./agent-registry.js";

describe("compileOperatorAgentRegistry", () => {
  afterEach(() => {
    invalidateRegistryCache();
    vi.restoreAllMocks();
  });

  it("compiles agents.yaml into a stable registry artifact", async () => {
    await withStateDirEnv("operator-registry-", async ({ stateDir }) => {
      await withTempDir("operator-registry-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "operator_runtime:",
            "  transports:",
            "    delegated_http:",
            "      global_default_alias: tonya",
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
            "    route_via_lead: true",
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
        expect(compiled.operatorRuntime.transports.angelaHttp.globalDefaultAlias).toBe("tonya");
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
          routeViaLead: true,
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

  it("compiles dispatch_default_alias and resolves angela-http fallback aliases", async () => {
    await withStateDirEnv("operator-registry-default-alias-", async () => {
      await withTempDir("operator-registry-default-alias-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "operator_runtime:",
            "  transports:",
            "    delegated_http:",
            "      global_default_alias: tonys-angels",
            "agents:",
            "  - id: tonys-angels",
            "    name: Tony's Angels",
            "  - id: bobby-digital",
            "    name: Bobby Digital",
            "teams:",
            "  - id: engineering",
            "    name: Engineering",
            "    lead: bobby-digital",
            "    route_via_lead: true",
            "    members: [bobby-digital]",
            "    dispatch_transport: angela-http",
            "    dispatch_default_alias: bobby-digital",
            "  - id: marketing",
            "    name: Marketing",
            "    lead: tonys-angels",
            "    route_via_lead: true",
            "    members: [tonys-angels]",
            "    dispatch_transport: angela-http",
            "    dispatch_default_alias: tonys-angels",
            "",
          ].join("\n"),
          "utf8",
        );

        const compiled = compileOperatorAgentRegistry({ sourcePath });

        expect(compiled.teams).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "engineering",
              dispatchDefaultAlias: "bobby-digital",
            }),
            expect.objectContaining({
              id: "marketing",
              dispatchDefaultAlias: "tonys-angels",
            }),
          ]),
        );
        expect(
          resolveOperatorDelegatedDefaultAlias({
            teamId: "engineering",
            sourcePath,
          }),
        ).toBe("bobby-digital");
        expect(resolveOperatorDelegatedDefaultAlias({ sourcePath })).toBe("tonys-angels");
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

  it("rejects unknown angela-http global default aliases", async () => {
    await withStateDirEnv("operator-registry-invalid-global-default-", async () => {
      await withTempDir("operator-registry-invalid-global-default-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "operator_runtime:",
            "  transports:",
            "    delegated_http:",
            "      global_default_alias: tonys-angels",
            "agents:",
            "  - id: tonya",
            "    name: Tonya",
            "",
          ].join("\n"),
          "utf8",
        );

        expect(() => compileOperatorAgentRegistry({ sourcePath })).toThrow(
          "operator_runtime delegated_http global_default_alias references unknown agent: tonys-angels",
        );
      });
    });
  });

  it("rejects unknown team dispatch_default_alias values", async () => {
    await withStateDirEnv("operator-registry-invalid-team-default-", async () => {
      await withTempDir("operator-registry-invalid-team-default-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "agents:",
            "  - id: tonya",
            "    name: Tonya",
            "teams:",
            "  - id: marketing",
            "    name: Marketing",
            "    lead: tonya",
            "    members: [tonya]",
            "    dispatch_transport: angela-http",
            "    dispatch_default_alias: tonys-angels",
            "",
          ].join("\n"),
          "utf8",
        );

        expect(() => compileOperatorAgentRegistry({ sourcePath })).toThrow(
          "team dispatch_default_alias references unknown agent: tonys-angels",
        );
      });
    });
  });

  it("rejects team dispatch_default_alias values that are outside the team", async () => {
    await withStateDirEnv("operator-registry-invalid-team-default-member-", async () => {
      await withTempDir("operator-registry-invalid-team-default-member-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          [
            "agents:",
            "  - id: tonya",
            "    name: Tonya",
            "  - id: bobby-digital",
            "    name: Bobby Digital",
            "teams:",
            "  - id: engineering",
            "    name: Engineering",
            "    lead: tonya",
            "    members: [tonya]",
            "    dispatch_transport: angela-http",
            "    dispatch_default_alias: bobby-digital",
            "",
          ].join("\n"),
          "utf8",
        );

        expect(() => compileOperatorAgentRegistry({ sourcePath })).toThrow(
          "team dispatch_default_alias must be a member of team engineering: bobby-digital",
        );
      });
    });
  });

  it("caches compiled registries until the source mtime changes", async () => {
    await withStateDirEnv("operator-registry-cache-", async () => {
      await withTempDir("operator-registry-cache-workspace-", async (dir) => {
        const sourcePath = path.join(dir, "agents.yaml");
        await fs.writeFile(
          sourcePath,
          ["agents:", "  - id: tonya", "    name: Tonya", ""].join("\n"),
          "utf8",
        );

        const readSpy = vi.spyOn(fsSync, "readFileSync");
        const first = compileOperatorAgentRegistry({ sourcePath });
        const second = compileOperatorAgentRegistry({ sourcePath });

        expect(second).toBe(first);
        expect(readSpy).toHaveBeenCalledTimes(1);

        await fs.writeFile(
          sourcePath,
          ["agents:", "  - id: tonya", "    name: Tonya", "  - id: deb", "    name: Deb", ""].join(
            "\n",
          ),
          "utf8",
        );
        const bumpedMtime = new Date(Date.now() + 2_000);
        await fs.utimes(sourcePath, bumpedMtime, bumpedMtime);

        const third = compileOperatorAgentRegistry({ sourcePath });
        expect(third).not.toBe(first);
        expect(third.agentCount).toBe(2);
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
