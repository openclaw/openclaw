import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { addPlan, consent, install, manifest, plan, source } from "./update-apply.test-helpers.js";

function agentDigest(config: AgentConfig & { id: string }): string {
  return `sha256:${createHash("sha256").update(stableStringify(config)).digest("hex")}`;
}

describe("applyClawUpdatePlan agent adoption", () => {
  it("rejects a materialized agent config that differs from the consented target", async () => {
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        desiredDigest: agentDigest(addPlan.agent.config),
      },
    ]);
    const changedAddPlan = structuredClone(addPlan);
    changedAddPlan.agent.config.name = "Changed after consent";

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => changedAddPlan),
          readInstall: vi.fn(() => install),
        },
      ),
    ).rejects.toMatchObject({ code: "update_changed" });
  });

  it("preserves an adopted agent default marker in config and provenance", async () => {
    const liveAgent = {
      id: "worker",
      name: "Worker",
      workspace: "/tmp/workspace-worker",
      default: true,
    };
    const currentDigest = agentDigest(liveAgent);
    const adoptedInstall: PersistedClawInstall = {
      ...install,
      schemaVersion: "openclaw.clawInstallRecord.v3",
      agentOrigin: "adopted",
      agentConfigDigest: currentDigest,
    };
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
        desiredDigest: agentDigest({ ...addPlan.agent.config, default: true }),
      },
    ]);
    let config: OpenClawConfig = {
      agents: {
        entries: {
          WORKER: { name: liveAgent.name, workspace: liveAgent.workspace, default: true },
        },
      },
    };
    const persistInstall = vi.fn((targetPlan: ClawAddPlan) => {
      expect(targetPlan.agent.config.default).toBe(true);
      return adoptedInstall;
    });

    await applyClawUpdatePlan(
      updatePlan,
      { targetManifest: manifest, targetSource: source },
      {
        config,
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        buildAddPlan: vi.fn(async () => addPlan),
        readInstall: vi.fn(() => adoptedInstall),
        persistInstall,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: async () => undefined })),
        applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: async () => undefined })),
        applyCron: vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined })),
        applyPackage: vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined })),
      },
    );

    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker v2",
      workspace: "/tmp/workspace-worker",
      default: true,
    });
    expect(config.agents?.entries?.WORKER).toBeUndefined();
    expect(persistInstall).toHaveBeenCalledOnce();
  });

  it("preserves unrelated agents when updating a legacy list roster", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = agentDigest(currentAgent);
    const adoptedInstall: PersistedClawInstall = {
      ...install,
      schemaVersion: "openclaw.clawInstallRecord.v3",
      agentOrigin: "adopted",
      agentConfigDigest: currentDigest,
    };
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
        desiredDigest: agentDigest(addPlan.agent.config),
      },
    ]);
    let config: OpenClawConfig = {
      agents: {
        list: [
          { id: "worker", name: "Worker" },
          { id: "other", name: "Other" },
        ],
      },
    };

    await applyClawUpdatePlan(
      updatePlan,
      { targetManifest: manifest, targetSource: source },
      {
        config,
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        buildAddPlan: vi.fn(async () => addPlan),
        readInstall: vi.fn(() => adoptedInstall),
        persistInstall: vi.fn(() => adoptedInstall),
        commitConfig: async (transform) => {
          config = transform(config);
        },
        applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: async () => undefined })),
        applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: async () => undefined })),
        applyCron: vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined })),
        applyPackage: vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined })),
      },
    );

    expect(config.agents?.list).toBeUndefined();
    expect(config.agents?.entries).toEqual({
      other: { name: "Other" },
      worker: { name: "Worker v2", workspace: "/tmp/workspace-worker" },
    });
  });
});
