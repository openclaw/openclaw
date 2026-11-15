import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as configPaths from "../config/paths.js";
import * as repairRuntime from "../infra/update-repair-agent.runtime.js";
import { repairRoute } from "../infra/update-repair-agent.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import * as doctorPolicy from "./doctor-service-repair-policy.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(),
  oracle: vi.fn(),
  serviceStop: vi.fn(),
}));
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: async (params: {
    selection: { provider: string; model: string };
    runCandidate: (
      provider: string,
      model: string,
      options: { agentHarnessRuntimeOverride: string },
    ) => Promise<unknown>;
  }) => {
    const { provider, model } = params.selection;
    const result = await params.runCandidate(provider, model, {
      agentHarnessRuntimeOverride: "openclaw",
    });
    return { result, provider, model, terminal: { outcome: { status: "ok" } } };
  },
}));
vi.mock("./doctor-lint-runner.js", () => ({ collectDoctorFindings: async () => [] }));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runUtf8CommandWithTimeout: mocks.oracle,
}));
vi.mock("../daemon/gateway-entrypoint.js", async (original) => ({
  ...(await original<typeof import("../daemon/gateway-entrypoint.js")>()),
  resolveGatewayInstallEntrypoint: async (root: string) => path.join(root, "openclaw.mjs"),
}));
vi.mock("../cli/update-cli/update-command-service-maintenance.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.serviceStop,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "triage repairs synthetic state without Doctor service effects and restores policy (throws=%s)",
  async (throws) => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      vi.spyOn(configPaths, "isDefaultInstallIdentity").mockReturnValue(true);
      vi.spyOn(doctorPolicy, "shouldManageGatewayService").mockResolvedValue(true);
      const keys = [
        "OPENCLAW_SERVICE_REPAIR_POLICY",
        "OPENCLAW_UPDATE_IN_PROGRESS",
        "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
        "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART",
      ];
      keys.forEach((key) => vi.stubEnv(key, undefined));
      const config = {
        plugins: { enabled: false },
        agents: { entries: { repair: { model: "fixture/repair" } } },
      };
      await state.writeConfig(config);
      vi.spyOn(repairRuntime, "prepareUpdateRepairInference").mockResolvedValue({
        ok: true,
        route: {
          ...repairRoute(state.statePath("agents", "repair", "agent"), config),
          agentId: "repair",
        },
        modelFallbacks: [],
      });
      const marker = state.statePath("repair-marker.txt");
      let repaired = false;
      const runtime = createTriageRuntime();
      mocks.oracle.mockImplementation(async () => ({
        code: repaired ? 0 : 1,
        termination: "exit",
        stdout: JSON.stringify({
          ok: repaired,
          findings: repaired ? [] : [{ severity: "error", message: "Synthetic repair needed" }],
        }),
      }));
      mocks.runEmbeddedAgent.mockImplementation(async () => {
        expect({
          service: doctorPolicy.resolveServiceRepairPolicy(),
          activation: doctorPolicy.resolveUpdateParentGatewayActivation(process.env),
        }).toEqual({ service: "external", activation: false });
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true },
          root: state.workspaceDir,
          runtime,
        });
        expect(maintenance).toBeDefined();
        try {
          await fs.writeFile(marker, "repaired");
          await maintenance?.finish(config);
        } finally {
          await maintenance?.release();
        }
        if (throws) {
          throw new Error("Synthetic executor failure");
        }
        repaired = true;
        return {
          payloads: [{ text: 'REPAIR_RESULT: {"status":"fixed","summary":"Repaired"}' }],
          meta: { durationMs: 1 },
        };
      });
      const run = withTriageTerminal(true, () =>
        triageCommand(runtime, { run: true, noExport: true }),
      );
      if (throws) {
        await expect(run).rejects.toMatchObject({ code: 1 });
      } else {
        await run;
        expect(runtime.log).toHaveBeenCalledWith(
          "Embedded repair repaired: Doctor lint reports no errors.",
        );
      }
      expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(await fs.readFile(marker, "utf8")).toBe("repaired");
      expect(mocks.serviceStop).not.toHaveBeenCalled();
      expect(keys.filter((key) => process.env[key] !== undefined)).toEqual([]);
    });
  },
);
