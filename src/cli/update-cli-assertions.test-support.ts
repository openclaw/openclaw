import path from "node:path";
import { expect, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import { createUpdateFixtureAssertions } from "./update-cli-shared-fixture.test-support.js";
import { isLegacyUpdateDoctorCommand } from "./update-cli/update-command-transport.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

export function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export const expectUpdateCallChannel = (channel: string) => {
  const call = vi.mocked(update.updateGitCheckout).mock.calls[0]?.[0];
  expect(call?.opts.channel).toBe(channel);
  return call;
};
export const commandCalls = () =>
  vi.mocked(update.runCommandWithTimeout).mock.calls as unknown as Array<
    [string[], Record<string, unknown>]
  >;

export const packageInstallCommandCall = () =>
  commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");

const packagePackCommandCall = () =>
  commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "pack");

const isNpmGitPackageSpec = (spec: string) => {
  const target = spec.trim().replace(/^openclaw@/i, "");
  if (
    /^(?:github:|git[+:]|ssh:\/\/)/i.test(target) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) ||
    /^[^.\s/:@][^\s/:@]*\/[^\s/:@]+$/u.test(target.split("#", 1)[0] ?? "")
  ) {
    return true;
  }
  try {
    const url = new URL(target);
    const pathname = url.pathname.replace(/\/+$/u, "");
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (pathname.endsWith(".git") ||
        (url.hostname.toLowerCase() === "github.com" &&
          pathname.split("/").filter(Boolean).length === 2))
    );
  } catch {
    return false;
  }
};

export const doctorCommandCall = () =>
  commandCalls().find(([argv]) => isLegacyUpdateDoctorCommand(argv));

export const doctorCommandCallIndex = () =>
  commandCalls().findIndex(([argv]) => isLegacyUpdateDoctorCommand(argv));

export const freshRestartCalls = () =>
  vi
    .mocked(update.runCommandWithTimeout)
    .mock.calls.filter(([argv]) => argv[2] === "gateway" && argv[3] === "restart");

export const gatewayCommandCall = (entryPath: string, action: "install" | "restart") =>
  commandCalls().find(
    ([argv]) => argv[1] === entryPath && argv[2] === "gateway" && argv[3] === action,
  );

export const spawnCall = (index = 0) => {
  const calls = mocks.spawn.mock.calls as unknown as Array<
    [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }]
  >;
  return calls[index];
};

export const completionCommandCall = () =>
  commandCalls().find(([argv]) => argv[2] === "completion");

export const {
  syncPluginCall,
  npmPluginUpdateCall,
  lastNpmPluginUpdateCall,
  replaceConfigCall,
  lastReplaceConfigCall,
  setupConfigMutationWithRetryMock,
  lastWriteJsonCall,
  getLogOutput,
  getErrorOutput,
} = createUpdateFixtureAssertions({
  syncPluginsForUpdateChannel: mocks.syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
  readConfigFileSnapshot: update.readConfigFileSnapshot,
  mutateConfigFileWithRetry: update.mutateConfigFileWithRetry,
  replaceConfigFile: update.replaceConfigFile,
  defaultRuntime: update.defaultRuntime,
});

export const mockMutableConfigSnapshot = (initial: ConfigFileSnapshot) => {
  let current = initial;
  vi.mocked(update.readConfigFileSnapshot).mockImplementation(async () => current);
  setupConfigMutationWithRetryMock((snapshot, nextConfig) => {
    current = {
      ...snapshot,
      parsed: nextConfig,
      sourceConfig: nextConfig,
      resolved: nextConfig,
      config: nextConfig,
      runtimeConfig: nextConfig,
    };
  });
};

export const expectNoSideEffects = (...effects: unknown[]) => {
  for (const effect of effects) {
    expect(effect).not.toHaveBeenCalled();
  }
};

export const gatewayHealthCall = (index = 0) => mocks.callGateway.mock.calls[index]?.[0];

export const pluginWarning = (result?: UpdateRunResult) =>
  result?.postUpdate?.plugins?.warnings?.[0];
export const pluginOutcome = (result?: UpdateRunResult) =>
  result?.postUpdate?.plugins?.npm.outcomes[0];

export const expectPackageInstallSpec = (spec: string, staged = true) => {
  expect(update.updateGitCheckout).not.toHaveBeenCalled();
  let installSpec = spec;
  const isGit = isNpmGitPackageSpec(spec);
  if (isGit) {
    const packCall = packagePackCommandCall();
    expect(packCall?.[0]).toEqual([
      "npm",
      "pack",
      spec,
      "--pack-destination",
      expect.any(String),
      "--json",
      "--loglevel=error",
    ]);
    const packDir = requireValue(packCall?.[0][4] || undefined, "package pack directory");
    installSpec = path.join(packDir, "openclaw-9999.0.0.tgz");
  } else {
    expect(packagePackCommandCall()).toBeUndefined();
  }
  const allowScriptsIdentity = isGit
    ? installSpec
    : spec.toLowerCase().startsWith("openclaw@")
      ? "openclaw"
      : spec;
  const call = packageInstallCommandCall();
  expect(call?.[0]).toEqual([
    "npm",
    "i",
    "-g",
    `--allow-scripts=${allowScriptsIdentity}`,
    ...(staged ? ["--prefix", expect.stringContaining(".openclaw.update-stage-")] : []),
    installSpec,
    "--no-fund",
    "--no-audit",
    "--loglevel=error",
    "--min-release-age=0",
  ]);
  requireValue(call?.[1], "package install command options");
};
