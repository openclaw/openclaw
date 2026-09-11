import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { buildRuntimeReadiness } from "./conditions.js";
import { createSelectedReadinessResolver, reserveSelectedReadinessSubjects } from "./selection.js";
import { createGatewayReadinessIdentity } from "./subjects.js";

function chainedCriterion(
  pluginId: string,
  criterionId: string,
  subjectCount = 64,
): PluginReadinessCriterionRegistration {
  return {
    id: `plugin.${pluginId}.${criterionId}`,
    pluginId,
    source: `/plugins/${pluginId}/index.js`,
    criterion: {
      id: criterionId,
      description: "Reports readiness with a retained subject chain.",
      check: ({ subjects }) => {
        let parentRef: string | undefined;
        for (let index = 0; index < subjectCount; index += 1) {
          parentRef = subjects.declare({
            kind: "node",
            key: `level-${index}`,
            ...(parentRef ? { parentRef } : {}),
          });
        }
        return {
          subjectRef: parentRef,
          status: "True",
          reason: "PluginReady",
          message: "Plugin is ready.",
        };
      },
    },
  };
}

describe("selected readiness aggregate subject limit", () => {
  it("degrades only overflowing advisory evidence and preserves required readiness", async () => {
    const advisory = chainedCriterion("advisory", "backend");
    const required = chainedCriterion("required", "backend");
    const contribution = await createSelectedReadinessResolver()({
      config: {
        gateway: {
          readiness: {
            advisoryCriteria: [advisory.id],
            requiredCriteria: [required.id],
          },
        },
      },
      registry: { readinessCriteria: [advisory, required] },
    });

    expect(contribution.conditions).toEqual([
      expect.objectContaining({
        type: advisory.id,
        status: "Unknown",
        requirement: "advisory",
        reason: "CriterionSubjectLimitExceeded",
      }),
      expect.objectContaining({
        type: required.id,
        status: "True",
        requirement: "required",
        reason: "PluginReady",
      }),
    ]);
    expect(
      contribution.subjects.some((subject) => subject.ref.startsWith("plugin.advisory/")),
    ).toBe(false);
    expect(
      contribution.subjects.some((subject) => subject.ref.startsWith("plugin.required/")),
    ).toBe(true);

    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: contribution.conditions,
      additionalSubjects: contribution.subjects,
    });
    expect(readiness).toMatchObject({
      ready: true,
      failures: [],
      advisories: ["CriterionSubjectLimitExceeded"],
    });
    expect(readiness.identity.subjects.length).toBeLessThanOrEqual(128);
  });

  it("counts a selected workspace subject before accepting plugin evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-subject-limit-"));
    const advisory = chainedCriterion("advisory", "workspace", 59);
    const required = chainedCriterion("required", "workspace");
    try {
      const contribution = await createSelectedReadinessResolver()({
        config: {
          agents: { defaults: { workspace } },
          gateway: {
            readiness: {
              advisoryCriteria: [advisory.id],
              requiredCriteria: ["openclaw.workspace-writable", required.id],
            },
          },
        },
        registry: { readinessCriteria: [advisory, required] },
      });

      expect(contribution.conditions).toContainEqual(
        expect.objectContaining({
          type: advisory.id,
          status: "Unknown",
          requirement: "advisory",
          reason: "CriterionSubjectLimitExceeded",
        }),
      );
      const readiness = buildRuntimeReadiness({
        identity: createGatewayReadinessIdentity({ hostInstanceId: "host-1" }),
        configLoaded: true,
        gateway: "responding",
        plugins: { errors: [] },
        additionalConditions: contribution.conditions,
        additionalSubjects: contribution.subjects,
      });
      expect(readiness.ready).toBe(true);
      expect(readiness.identity.subjects.length).toBeLessThanOrEqual(128);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reserves externally composed subjects before retaining plugin evidence", async () => {
    const advisory = chainedCriterion("advisory", "reserved", 60);
    const required = chainedCriterion("required", "reserved", 60);
    const contribution = await createSelectedReadinessResolver()({
      config: {
        gateway: {
          readiness: {
            advisoryCriteria: [advisory.id],
            requiredCriteria: [required.id],
          },
        },
      },
      registry: { readinessCriteria: [advisory, required] },
    });
    const reservedSubjects = Array.from({ length: 4 }, (_, index) => ({
      ref: `openclaw/reserved/${index}`,
      kind: "openclaw.reserved",
      parentRef: "openclaw/gateway/current",
    }));

    const bounded = reserveSelectedReadinessSubjects(contribution, reservedSubjects);

    expect(bounded.conditions).toEqual([
      expect.objectContaining({
        type: advisory.id,
        status: "Unknown",
        reason: "CriterionSubjectLimitExceeded",
      }),
      expect.objectContaining({
        type: required.id,
        status: "True",
      }),
    ]);
    const readiness = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [] },
      additionalConditions: bounded.conditions,
      additionalSubjects: [...reservedSubjects, ...bounded.subjects],
    });
    expect(readiness.identity.subjects.length).toBeLessThanOrEqual(128);
  });
});
