import { describe, expect, it, vi } from "vitest";
import { clawPackageRemovalRequestSchema } from "./package-remove-contract.js";
import { applyClawPackageRemovalPhase } from "./package-remove-phase.js";
import { digestClawPackageRemovalPlan } from "./package-remove-plan.js";
import {
  planClawPackageRemovals,
  type ClawPackageRemovalDecision,
  type ClawReferencedCleanup,
} from "./package-remove.js";
import type { PersistedClawPackageRef } from "./provenance.js";

const mocks = vi.hoisted(() => ({ local: vi.fn() }));
vi.mock("./package-remove.js", async (original) => ({
  ...(await original<typeof import("./package-remove.js")>()),
  applyClawPackageRemovals: (...args: unknown[]) => mocks.local(...args),
}));
vi.mock("./provenance.js", async (original) => ({
  ...(await original<typeof import("./provenance.js")>()),
  readClawInstallRecord: () => undefined,
}));

function reference(relationship: "managed" | "referenced"): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "worker",
    kind: "plugin",
    source: "clawhub",
    ref: "audit",
    version: "1.0.0",
    integrity: "sha256:audit",
    status: "complete",
    relationship,
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
  };
}
const application = { operationId: "runtime-removal", generation: 2, pluginIds: ["audit"] };
const uninstalled = {
  kind: "plugin" as const,
  ref: "audit",
  version: "1.0.0",
  action: "uninstalled" as const,
};
const options = {
  agentId: "worker",
  operationId: "deletion-operation",
  assertCurrent: () => undefined,
};

async function decisions(relationship: "managed" | "referenced", cleanup: ClawReferencedCleanup) {
  const ref = reference(relationship);
  return await planClawPackageRemovals({ workspace: "/synthetic-workspace" }, [ref], {
    referencedCleanup: cleanup,
    deps: {
      readPackageRefs: () => [ref],
      resolvePlugin: async () => ({
        status: "found",
        pluginId: "audit",
        installedVersion: "1.0.0",
        record: {
          source: "clawhub",
          integrity: ref.integrity,
          installedAt: "1970-01-01T00:00:00.001Z",
        },
      }),
    },
  });
}

describe("Claw package phase handoff", () => {
  it.each(["retain", "remove-if-unused"] as const)(
    "keeps referenced plugins retained under %s",
    async (mode) => {
      const cleanup = { mode };
      const planned = await decisions("referenced", cleanup);
      expect(planned[0]?.action).toBe("retain");
      const packageGateway = vi.fn();
      mocks.local.mockResolvedValue({ packages: [{ ...uninstalled, action: "retained" }] });
      await applyClawPackageRemovalPhase(planned, {
        ...options,
        referencedCleanup: cleanup,
        packageGateway,
      });
      expect(packageGateway).not.toHaveBeenCalled();
    },
  );

  it.each(["managed", "referenced"] as const)(
    "hands off the canonical %s plugin removal decision without local mutation",
    async (relationship) => {
      mocks.local.mockClear();
      const cleanup: ClawReferencedCleanup =
        relationship === "managed"
          ? { mode: "retain" }
          : { mode: "remove-selected", selected: ["plugin:audit@1.0.0"] };
      const planned = await decisions(relationship, cleanup);
      expect(planned[0]?.action).toBe("uninstall");
      const packageGateway = vi.fn(async (request) => {
        const wireRequest = JSON.stringify(request);
        const received = clawPackageRemovalRequestSchema.parse({
          ...JSON.parse(wireRequest),
          binding: {
            configPath: "/synthetic-config",
            statePath: "/synthetic-state",
            cronStorePath: "/synthetic-cron",
          },
        });
        expect(received.expectedPackagePlanDigest).toBe(
          digestClawPackageRemovalPlan(planned, received.cleanup),
        );
        return { packages: [uninstalled], application };
      });
      expect(
        await applyClawPackageRemovalPhase(planned, {
          ...options,
          referencedCleanup: cleanup,
          packageGateway,
        }),
      ).toEqual({ packages: [uninstalled], application });
      expect(packageGateway).toHaveBeenCalledOnce();
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );

  it("preserves managed-before-referenced ordering for a mixed phase", async () => {
    mocks.local.mockClear();
    const cleanup = { mode: "remove-selected" as const, selected: ["plugin:audit@1.0.0"] };
    const planned = await decisions("referenced", cleanup);
    const skill: ClawPackageRemovalDecision = {
      ...planned[0]!,
      packageRef: { ...reference("managed"), kind: "skill", ref: "triage" },
    };
    const packages = [{ ...uninstalled, kind: "skill" as const, ref: "triage" }, uninstalled];
    const packageGateway = vi.fn(async () => ({ packages, application }));
    expect(
      (
        await applyClawPackageRemovalPhase([...planned, skill], {
          ...options,
          referencedCleanup: cleanup,
          packageGateway,
        })
      ).packages,
    ).toEqual(packages);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["transport", "missing outcome", "wrong owner", "missing application"])(
    "rejects %s without retry or local fallback",
    async (failure) => {
      mocks.local.mockClear();
      const cleanup = { mode: "remove-selected" as const, selected: ["plugin:audit@1.0.0"] };
      const planned = await decisions("referenced", cleanup);
      const packageGateway = vi.fn(async () => {
        if (failure === "transport") {
          throw new Error("connection lost");
        }
        return {
          packages:
            failure === "missing outcome"
              ? []
              : [{ ...uninstalled, ref: failure === "wrong owner" ? "other" : "audit" }],
          ...(failure === "missing application" ? {} : { application }),
        };
      });
      await expect(
        applyClawPackageRemovalPhase(planned, {
          ...options,
          referencedCleanup: cleanup,
          packageGateway,
        }),
      ).rejects.toThrow();
      expect(packageGateway).toHaveBeenCalledOnce();
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );
});
