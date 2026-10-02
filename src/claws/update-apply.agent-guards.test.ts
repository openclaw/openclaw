import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { addPlan, consent, install, manifest, plan, source } from "./update-apply.test-helpers.js";

afterEach(closeOpenClawStateDatabaseForTest);

describe("applyClawUpdatePlan agent guards", () => {
  it("restores the agent when the config commit throws after transforming state", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
      },
    ]);
    let config: OpenClawConfig = {
      agents: {
        entries: {
          worker: { name: "Worker", model: { primary: "acme/original" } },
        },
      },
    };
    let commits = 0;

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          commitConfig: async (transform) => {
            config = transform(config, config);
            commits += 1;
            if (commits === 1) {
              config.agents!.entries!.worker!.model = { primary: "acme/changed-after-write" };
              throw new Error("post-write failure");
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent_update_failed" });
    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker",
      model: { primary: "acme/changed-after-write" },
    });
    expect(commits).toBe(2);
  });

  it("does not recreate an agent removed after planning", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: {} } };

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          commitConfig: async (transform) => {
            config = transform(config, config);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent_changed" });
    expect(config.agents?.entries?.worker).toBeUndefined();
  });

  it("rejects a stale or manually blocked plan", async () => {
    const updatePlan = plan([]);
    const changed = { ...updatePlan, targetClaw: { ...updatePlan.targetClaw!, version: "3.0.0" } };
    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => changed),
          readInstall: vi.fn(() => install),
        },
      ),
    ).rejects.toMatchObject({ code: "update_changed" });

    await expect(
      applyClawUpdatePlan(
        {
          ...updatePlan,
          actions: [
            {
              kind: "agent",
              id: "worker",
              action: "manual",
              target: "agent",
              blocked: true,
              reason: "drift",
            },
          ],
        },
        { targetManifest: manifest, targetSource: source },
        { config: {}, ...consent(updatePlan), readInstall: vi.fn(() => install) },
      ),
    ).rejects.toMatchObject({ code: "update_blocked" });
  });
});
