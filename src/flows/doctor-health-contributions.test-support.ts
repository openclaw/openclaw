import fs from "node:fs";
import path from "node:path";
import type { maybeRepairGatewayServiceConfig } from "../commands/doctor-gateway-services.js";
import type { OpenClawConfig, OpenClawConfigInput } from "../config/config.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext as Context,
} from "./doctor-health-contribution-types.js";
import "./doctor-health-contributions.js";
import type { runDoctorLintChecks } from "./doctor-lint-flow.js";
export {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "./doctor-health-context.test-support.js";

type RunContributions = (ctx: Context, list: readonly DoctorHealthContribution[]) => Promise<void>;
type TestApi = {
  resolveDoctorHealthContributions(): DoctorHealthContribution[];
  runDoctorHealthContributionList: RunContributions;
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

export function doctorRuntimeProjectedPath(directory: string, source: string): string {
  const base = path.parse(source).root;
  return path.join(
    directory,
    "tree",
    Buffer.from(base).toString("hex"),
    path.relative(base, source),
  );
}

export function createDoctorRuntimeProjection(root: string, packageRoot: string, suffix: string) {
  const directory = path.join(root, `openclaw-update-runtime-${suffix}`);
  const projectedRoot = doctorRuntimeProjectedPath(directory, packageRoot);
  fs.mkdirSync(projectedRoot, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(projectedRoot, "package.json"));
  return directory;
}
