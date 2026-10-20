import { vi } from "vitest";
import type { maybeRepairGatewayServiceConfig } from "../commands/doctor-gateway-services.js";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig, OpenClawConfigInput } from "../config/config.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext as Context,
} from "./doctor-health-contribution-types.js";
import "./doctor-health-contributions.js";
import type { runDoctorLintChecks } from "./doctor-lint-flow.js";

type RunContributions = (ctx: Context, list: readonly DoctorHealthContribution[]) => Promise<void>;
type TestApi = {
  resolveDoctorHealthContributions(): DoctorHealthContribution[];
  runDoctorHealthContributionList: RunContributions;
};

type ContextFixture = Partial<Omit<Context, "configResult">> & {
  configResult?: Partial<Context["configResult"]>;
};

type DoctorLintContext = Parameters<typeof runDoctorLintChecks>[0];

export function createDoctorConfigFixture(input: OpenClawConfigInput): OpenClawConfig {
  return input as OpenClawConfig;
}

export function createDoctorLintContext(
  fixture: Pick<DoctorLintContext, "cfg"> & Partial<Omit<DoctorLintContext, "cfg">>,
): DoctorLintContext {
  return fixture as DoctorLintContext;
}

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

function getTestApi(): TestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHealthContributionsTestApi")
  ];
  if (!api) {
    throw new Error("doctor health contributions test API is unavailable");
  }
  return api as TestApi;
}

export function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return getTestApi().resolveDoctorHealthContributions();
}

export const runDoctorHealthContributionList: RunContributions = async (...args) => {
  await getTestApi().runDoctorHealthContributionList(...args);
};

/** Keep the token candidate and service-repair writer on the same persistence path. */
export function createGatewayWriterFixture(token: string) {
  const config: OpenClawConfig = { gateway: { auth: { mode: "token", token } } };
  const repair: typeof maybeRepairGatewayServiceConfig = async (...args) =>
    args[4].writeConfig(config);
  return { config, repair };
}
