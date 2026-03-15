import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { invalidateRegistryCache } from "./agent-registry.js";
import { resolveOperatorReferenceSourcePath } from "./reference-paths.js";
import {
  listVisibleSpecialistTeams,
  resolveRequesterVisibleTeamIds,
  resolveSpecialistTarget,
} from "./specialist-resolver.js";

async function seedRegistryFixture(): Promise<void> {
  const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(
    sourcePath,
    [
      "agents:",
      "  - id: bobby-digital",
      "    name: Bobby Digital",
      "    specialty: Engineering",
      "    triggers: [engineering, backend]",
      "    max_concurrent_sessions: 1",
      "  - id: method-man",
      "    name: Method Man",
      "    specialty: Frontend",
      "    triggers: [frontend, ui]",
      "    max_concurrent_sessions: 2",
      "  - id: inspectah",
      "    name: Inspectah",
      "    specialty: QA",
      "    triggers: [qa, testing]",
      "  - id: ghostface",
      "    name: Ghostface",
      "    specialty: Backend",
      "    triggers: [backend, api]",
      "teams:",
      "  - id: engineering",
      "    name: Engineering",
      "    lead: bobby-digital",
      "    route_via_lead: true",
      "    members: [bobby-digital]",
      "    max_parallel: 1",
      "  - id: frontend",
      "    name: Frontend",
      "    parent_team_id: engineering",
      "    lead: method-man",
      "    members: [method-man, inspectah]",
      "    owns_capabilities: [frontend, ui]",
      "  - id: backend",
      "    name: Backend",
      "    parent_team_id: engineering",
      "    lead: ghostface",
      "    members: [ghostface]",
      "    owns_capabilities: [backend]",
      "  - id: acp-lab",
      "    name: ACP Lab",
      "    parent_team_id: engineering",
      "    lead: codex",
      "    runtime_ids: [codex]",
      "    owns_capabilities: [analysis]",
      "k8s_cluster:",
      "  - id: codex",
      "    name: Codex",
      "    role: Analysis",
      "    triggers: [analysis]",
      "    max_concurrent_sessions: 2",
      "",
    ].join("\n"),
    "utf8",
  );
  invalidateRegistryCache({ sourcePath });
}

describe("specialist resolver", () => {
  beforeEach(() => {
    invalidateRegistryCache();
  });

  it("limits visible teams to the caller plus descendant teams they lead", async () => {
    await withStateDirEnv("specialist-resolver-scope-", async () => {
      await seedRegistryFixture();

      expect(resolveRequesterVisibleTeamIds({ requesterId: "bobby-digital" })).toEqual([
        "acp-lab",
        "backend",
        "engineering",
        "frontend",
      ]);
      expect(resolveRequesterVisibleTeamIds({ requesterId: "method-man" })).toEqual(["frontend"]);
    });
  });

  it("routes via the lead when route_via_lead is enabled", async () => {
    await withStateDirEnv("specialist-resolver-lead-", async () => {
      await seedRegistryFixture();

      const resolved = resolveSpecialistTarget({
        requesterId: "bobby-digital",
        teamId: "engineering",
        capability: "backend",
        runtimePreference: "subagent",
      });

      expect(resolved.identityId).toBe("bobby-digital");
      expect(resolved.leadRouted).toBe(true);
      expect(resolved.teamId).toBe("engineering");
    });
  });

  it("uses capability or role alias to pick the matching specialist", async () => {
    await withStateDirEnv("specialist-resolver-capability-", async () => {
      await seedRegistryFixture();

      const capabilityResolved = resolveSpecialistTarget({
        requesterId: "bobby-digital",
        teamId: "backend",
        capability: "backend",
        runtimePreference: "subagent",
      });
      const roleResolved = resolveSpecialistTarget({
        requesterId: "bobby-digital",
        teamId: "backend",
        role: "backend",
        runtimePreference: "subagent",
      });

      expect(capabilityResolved.identityId).toBe("ghostface");
      expect(roleResolved.identityId).toBe("ghostface");
      expect(roleResolved.roleAliasUsed).toBe(true);
    });
  });

  it("supports runtime identities for acp routing", async () => {
    await withStateDirEnv("specialist-resolver-runtime-", async () => {
      await seedRegistryFixture();

      const resolved = resolveSpecialistTarget({
        requesterId: "bobby-digital",
        teamId: "acp-lab",
        capability: "analysis",
        runtimePreference: "acp",
      });

      expect(resolved.identityId).toBe("codex");
      expect(resolved.kind).toBe("runtime");
    });
  });

  it("builds visible team metadata with member capabilities and concurrency", async () => {
    await withStateDirEnv("specialist-resolver-visibility-", async () => {
      await seedRegistryFixture();

      const teams = listVisibleSpecialistTeams({
        requesterId: "bobby-digital",
        configuredAgentIds: ["bobby-digital", "method-man", "ghostface"],
      });
      const frontend = teams.find((team) => team.id === "frontend");

      expect(frontend?.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "method-man",
            configured: true,
            maxConcurrentSessions: 2,
          }),
          expect.objectContaining({
            id: "inspectah",
            configured: false,
          }),
        ]),
      );
      expect(frontend?.ownsCapabilities).toEqual(expect.arrayContaining(["frontend", "ui"]));
    });
  });
});
