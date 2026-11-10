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
import { waitForSignalExitBarriers } from "./signal-exit-barrier.js";
import { runTemplatesReleaseCommand } from "./templates-cli.release.js";

const prompt = vi.hoisted(() => ({ promptYesNo: vi.fn<() => Promise<boolean>>() }));
// mock-isolation: Stand in for the operator's interactive answer; custody and storage stay real.
vi.mock("./prompt.js", () => prompt);

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
    const editedTools = { ...tools, exec: { mode: "full" as const } };
    const config = {
      ...fixture.config,
      agents: { entries: { [id]: { ...agent, tools: editedTools } } },
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
        agentTools: editedTools,
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

  it("keeps the Template consent when offline custody ends after confirmation", async () => {
    const { resolveConsentAfterRestart } = await editedManagedAgent();
    // The operator confirms, then Ctrl-C reaches the CLI's signal path before the delete commits.
    prompt.promptYesNo.mockImplementationOnce(async () => {
      void waitForSignalExitBarriers("SIGINT");
      return true;
    });
    const streams = [process.stdin, process.stdout];
    for (const stream of streams) {
      Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    }
    try {
      await expect(runTemplatesReleaseCommand("worker", {})).rejects.toThrow();
    } finally {
      for (const stream of streams) {
        Reflect.deleteProperty(stream, "isTTY");
      }
    }

    expect(prompt.promptYesNo).toHaveBeenCalledOnce();
    await expect(resolveConsentAfterRestart()).rejects.toThrow(/edited after its Template consent/);
  });
});
