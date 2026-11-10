import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setAppliedRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { defaultRuntime } from "../runtime.js";
import {
  makeProvenancePlan,
  seedLegacyTemplateInstall,
} from "../templates/provenance.test-helpers.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { runTemplatesReleaseCommand } from "./templates-cli.release.js";

describe("templates release", () => {
  const fixture = useLocalStateOwnerFixture();

  async function editedManagedAgent() {
    const root = path.dirname(process.env.OPENCLAW_STATE_DIR!);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      {
        openClawProfile: {
          schemaVersion: 1,
          agent: { tools: { profile: "full", allow: ["read"] } },
        },
      },
    );
    seedLegacyTemplateInstall(plan, { env: process.env });
    const { id, tools, ...agent } = plan.agent.config;
    const config = {
      ...fixture.config,
      agents: {
        entries: { [id]: { ...agent, tools: { ...tools, exec: { mode: "full" as const } } } },
      },
    };
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
    await setAppliedRuntimeConfigSnapshot(config, config);
    // Each check loads consent like a freshly started Gateway; release is offline-only.
    const resolveConsentAfterRestart = async () => {
      vi.resetModules();
      const snapshot = await import("../config/runtime-snapshot.js");
      const { resolveTemplateToolPolicyConsent } =
        await import("../templates/tool-policy-runtime.js");
      await snapshot.setAppliedRuntimeConfigSnapshot(config, config);
      return resolveTemplateToolPolicyConsent({
        agentTools: config.agents.entries.worker.tools,
        agentId: "worker",
        hasAgentAllowlist: true,
        ownsProfile: true,
        profile: "full",
      });
    };
    return { resolveConsentAfterRestart };
  }

  it("lets an edited Template-managed agent run once the operator releases it", async () => {
    const { resolveConsentAfterRestart } = await editedManagedAgent();
    await expect(resolveConsentAfterRestart()).rejects.toThrow(
      /edited after its Template consent.*openclaw templates release worker/,
    );

    await runTemplatesReleaseCommand("worker", { yes: true });

    await expect(resolveConsentAfterRestart()).resolves.toEqual({ frozen: false });
  });

  it("keeps the Template consent when release is not confirmed", async () => {
    const { resolveConsentAfterRestart } = await editedManagedAgent();
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    await runTemplatesReleaseCommand("worker", {});

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Release not confirmed"));
    await expect(resolveConsentAfterRestart()).rejects.toThrow(/edited after its Template consent/);
  });
});
