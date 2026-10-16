import { vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import type { finalizeSetupWizard } from "./setup.finalize.js";

export function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

export type FinalizeArgs = Parameters<typeof finalizeSetupWizard>[0];

export type FinalizeArgsOverrides = Omit<Partial<FinalizeArgs>, "flow" | "opts" | "settings"> & {
  opts?: Partial<FinalizeArgs["opts"]>;
  settings?: Partial<FinalizeArgs["settings"]>;
};

export function createLaterPrompter() {
  return buildWizardPrompter(undefined, { defaultSelect: "later" });
}

export function createFinalizeArgs(
  flow: FinalizeArgs["flow"],
  overrides: FinalizeArgsOverrides = {},
): FinalizeArgs {
  const { opts, settings, ...rest } = overrides;
  return {
    flow,
    opts: {
      acceptRisk: true,
      authChoice: "skip",
      installDaemon: false,
      skipHealth: true,
      skipUi: flow === "advanced",
      ...opts,
    },
    baseConfig: {},
    nextConfig: {},
    workspaceDir: "/tmp",
    settings: {
      port: 18789,
      bind: "loopback",
      authMode: "token",
      gatewayToken: undefined,
      ...settings,
    },
    prompter: createLaterPrompter(),
    runtime: createRuntime(),
    ...rest,
  };
}
