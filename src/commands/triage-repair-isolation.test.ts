import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configPaths from "../config/paths.js";
import * as repairRuntime from "../infra/update-repair-agent.runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import * as doctorPolicy from "./doctor-service-repair-policy.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  agentExecCommand: vi.fn(),
  oracle: vi.fn(),
  serviceStop: vi.fn(),
}));
vi.mock("./agent-exec.js", () => ({ agentExecCommand: mocks.agentExecCommand }));
vi.mock("./doctor-lint.js", () => ({ collectDoctorFindings: async () => [] }));
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
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async () => {},
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("manual triage repair isolation", () => {
  it.each([false, true])(
    "repairs synthetic state without Doctor service effects and restores policy (throws=%s)",
    async (throws) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        // Triage, the repair loop, its environment owner, and Doctor maintenance
        // run real code; inference, executor, oracle, and service effects are mocked.
        vi.spyOn(configPaths, "isDefaultInstallIdentity").mockReturnValue(true);
        vi.spyOn(doctorPolicy, "shouldManageGatewayService").mockResolvedValue(true);
        mocks.serviceStop.mockResolvedValue({
          inspected: true,
          serviceUpdateVerdict: { kind: "owned", refreshDefinition: false },
          stopped: false,
        });
        const keys = [
          "OPENCLAW_SERVICE_REPAIR_POLICY",
          "OPENCLAW_UPDATE_IN_PROGRESS",
          "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
          "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION",
          "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
          "OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART",
        ];
        for (const key of keys) {
          vi.stubEnv(key, undefined);
        }
        const config = {
          plugins: { enabled: false },
          agents: { entries: { repair: { model: "fixture/repair" } } },
        };
        await state.writeConfig(config);
        vi.spyOn(repairRuntime, "prepareUpdateRepairInference").mockResolvedValue({
          ok: true,
          route: {
            runner: "embedded",
            agentId: "repair",
            agentDir: state.statePath("agents", "repair", "agent"),
            provider: "fixture",
            model: "repair",
            modelLabel: "fixture/repair",
            runConfig: config,
            sourceConfig: config,
          },
          modelFallbacks: [],
        });
        const marker = state.statePath("repair-marker.txt");
        let repaired = false;
        let observedPolicy: { service: string; activation: boolean | undefined } | undefined;
        const runtime = createTriageRuntime();
        mocks.oracle.mockImplementation(async () => ({
          code: repaired ? 0 : 1,
          termination: "exit",
          cleanup: "normal",
          stdout: JSON.stringify({
            ok: repaired,
            findings: repaired ? [] : [{ severity: "error", message: "Synthetic repair needed" }],
          }),
        }));
        mocks.agentExecCommand.mockImplementation(async () => {
          observedPolicy = {
            service: doctorPolicy.resolveServiceRepairPolicy(),
            activation: doctorPolicy.resolveUpdateParentGatewayActivation(process.env),
          };
          const maintenance = await beginDoctorMaintenance({
            options: { repair: true },
            root: state.workspaceDir,
            runtime,
          });
          expect(maintenance).toBeDefined();
          try {
            await fs.writeFile(marker, "repaired");
            repaired = true;
            await maintenance?.finish(config);
          } finally {
            await maintenance?.release();
          }
          if (throws) {
            throw new Error("Synthetic executor failure");
          }
          return {
            exitCode: 0,
            toolCalls: 1,
            envelope: {
              status: "ok",
              final: 'REPAIR_RESULT: {"status":"fixed","summary":"Synthetic repair completed"}',
            },
          };
        });
        await withTriageTerminal(true, () =>
          triageCommand(
            runtime,
            { run: true, noExport: true, json: true },
            {
              signal: new AbortController().signal,
              assertCurrent: () => {},
              operator: {
                kind: "operator",
                installationRoot: path.resolve(import.meta.dirname, "../.."),
                gateway: "preserve",
              },
            },
          ),
        );
        expect(runtime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            repair: expect.objectContaining({
              status: throws ? "aborted" : "repaired",
              ...(throws
                ? {
                    reason: "Synthetic executor failure",
                    finalValidation: expect.objectContaining({ ok: false }),
                  }
                : {}),
            }),
          }),
          2,
        );
        expect(mocks.agentExecCommand).toHaveBeenCalledOnce();
        expect(await fs.readFile(marker, "utf8")).toBe("repaired");
        expect(mocks.serviceStop).not.toHaveBeenCalled();
        expect(observedPolicy).toEqual({ service: "external", activation: false });
        for (const key of keys) {
          expect(process.env[key], key).toBeUndefined();
        }
      });
    },
  );
});
