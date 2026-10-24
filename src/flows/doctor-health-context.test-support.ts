import { vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { DoctorHealthFlowContext as Context } from "./doctor-health-contribution-types.js";

type ContextFixture = Partial<Omit<Context, "configResult">> & {
  configResult?: Partial<Context["configResult"]>;
};

export function createDoctorPrompterFixture(shouldRepair = false): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
  };
}

export function createDoctorHealthFlowContext(overrides: ContextFixture = {}): Context {
  const { configResult, ...contextOverrides } = overrides;
  const cfg = overrides.cfg ?? {};
  const configPath = overrides.configPath ?? "/tmp/openclaw.json";
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: {},
    prompter: createDoctorPrompterFixture(),
    configResult: {
      confirmedConfigSource: { path: configPath, hash: "planning-revision" },
      ...configResult,
      cfg: configResult?.cfg ?? cfg,
    },
    cfg,
    cfgForPersistence: cfg,
    sourceConfigValid: true,
    configPath,
    ...contextOverrides,
  };
}
