import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  callGateway,
  spawn,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  replaceConfigFile,
  runCommandWithTimeout,
  runUpdateFailureTriage,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import { createUpdateFixtureAssertions } from "./update-cli-shared-fixture.test-support.js";
import { isLegacyUpdateDoctorCommand } from "./update-cli/update-command-transport.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

const expectUpdateCallChannel = (channel: string) => {
  const call = vi.mocked(updateGitCheckout).mock.calls[0]?.[0];
  expect(call?.opts.channel).toBe(channel);
  return call;
};
const commandCalls = () =>
  vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<
    [string[], Record<string, unknown>]
  >;

const packageInstallCommandCall = () =>
  commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");

const packagePackCommandCall = () =>
  commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "pack");

const stripOpenClawPackageAlias = (spec: string) => {
  const trimmed = spec.trim();
  return trimmed.toLowerCase().startsWith("openclaw@")
    ? trimmed.slice("openclaw@".length)
    : trimmed;
};

const isNpmGitPackageSpec = (spec: string) => {
  const target = stripOpenClawPackageAlias(spec);
  const [repo] = target.split("#", 1);
  const isGitHubShorthand =
    Boolean(repo) &&
    !expectDefined(repo, "repo test invariant").startsWith(".") &&
    !expectDefined(repo, "repo test invariant").startsWith("/") &&
    !expectDefined(repo, "repo test invariant").startsWith("@") &&
    expectDefined(repo, "repo test invariant").split("/").length === 2 &&
    expectDefined(repo, "repo test invariant")
      .split("/")
      .every((part) => /^[^\s/:@]+$/u.test(part));
  let isHttpGitUrl;
  try {
    const url = new URL(target);
    const pathname = url.pathname.replace(/\/+$/u, "");
    const pathParts = pathname.split("/").filter(Boolean);
    isHttpGitUrl =
      (url.protocol === "https:" || url.protocol === "http:") &&
      (pathname.endsWith(".git") ||
        (url.hostname.toLowerCase() === "github.com" && pathParts.length === 2));
  } catch {
    isHttpGitUrl = false;
  }
  return (
    /^github:/i.test(target) ||
    /^git(?:\+|:)/i.test(target) ||
    /^ssh:\/\//i.test(target) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) ||
    isHttpGitUrl ||
    isGitHubShorthand
  );
};

const doctorCommandCall = () => commandCalls().find(([argv]) => isLegacyUpdateDoctorCommand(argv));

const doctorCommandCallIndex = () =>
  commandCalls().findIndex(([argv]) => isLegacyUpdateDoctorCommand(argv));

const freshRestartCalls = () =>
  vi
    .mocked(runCommandWithTimeout)
    .mock.calls.filter(([argv]) => argv[2] === "gateway" && argv[3] === "restart");

const gatewayCommandCall = (entryPath: string, action: "install" | "restart") =>
  commandCalls().find(
    ([argv]) => argv[1] === entryPath && argv[2] === "gateway" && argv[3] === action,
  );

const spawnCall = (index = 0) => {
  const calls = spawn.mock.calls as unknown as Array<
    [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }]
  >;
  return calls[index];
};

const completionCommandCall = () => commandCalls().find(([argv]) => argv[2] === "completion");

const {
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
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  readConfigFileSnapshot,
  mutateConfigFileWithRetry,
  replaceConfigFile,
  defaultRuntime,
});

const mockMutableConfigSnapshot = (initial: ConfigFileSnapshot) => {
  let current = initial;
  vi.mocked(readConfigFileSnapshot).mockImplementation(async () => current);
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

// Failure assertions must not render the triage target's inherited environment.
const getTriageFailures = () =>
  vi.mocked(runUpdateFailureTriage).mock.calls.map(([call]) => call.failure);
const expectNoSideEffects = (...effects: unknown[]) => {
  for (const effect of effects) {
    expect(effect).not.toHaveBeenCalled();
  }
};

const gatewayHealthCall = (index = 0) => callGateway.mock.calls[index]?.[0];

const pluginWarning = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.warnings?.[0];
const pluginOutcome = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.npm.outcomes[0];

const expectPackageInstallSpec = (spec: string, staged = true) => {
  expect(updateGitCheckout).not.toHaveBeenCalled();
  let installSpec = spec;
  if (isNpmGitPackageSpec(spec)) {
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
    const packDir = packCall?.[0][4];
    if (!packDir) {
      throw new Error("Expected package pack directory");
    }
    installSpec = path.join(packDir, "openclaw-9999.0.0.tgz");
  } else {
    expect(packagePackCommandCall()).toBeUndefined();
  }
  const allowScriptsIdentity = isNpmGitPackageSpec(spec)
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
  if (call?.[1] === undefined) {
    throw new Error("Expected package install command options");
  }
};

export {
  commandCalls,
  completionCommandCall,
  doctorCommandCall,
  doctorCommandCallIndex,
  expectNoSideEffects,
  expectPackageInstallSpec,
  expectUpdateCallChannel,
  freshRestartCalls,
  gatewayCommandCall,
  gatewayHealthCall,
  getErrorOutput,
  getLogOutput,
  getTriageFailures,
  lastNpmPluginUpdateCall,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  mockMutableConfigSnapshot,
  npmPluginUpdateCall,
  packageInstallCommandCall,
  pluginOutcome,
  pluginWarning,
  replaceConfigCall,
  requireValue,
  setupConfigMutationWithRetryMock,
  spawnCall,
  syncPluginCall,
};
