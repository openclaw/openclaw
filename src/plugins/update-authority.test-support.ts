import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import type { UpdateRecoveryFence } from "../infra/update-run-recovery.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";

type Plugins = NonNullable<OpenClawConfig["plugins"]>;

export async function withPluginState<T>(
  label: string,
  run: (state: OpenClawTestState) => Promise<T>,
) {
  const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  return withOpenClawTestState({ label, env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, run);
}

export function pluginInstallRoots(state: OpenClawTestState) {
  return {
    stateDir: state.stateDir,
    extensionsDir: state.statePath("extensions"),
    npmDir: state.statePath("npm"),
    gitDir: state.statePath("git"),
  };
}

export async function useUpdateControl(state: OpenClawTestState) {
  const control = state.path("control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
}

export async function withUpdater<T>(
  state: OpenClawTestState,
  preflight: boolean,
  run: (fence: UpdateRecoveryFence) => Promise<T>,
) {
  const { createUpdateRun } = await import("../infra/update-run-ledger.js");
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const update = createUpdateRun({ trigger: "cli" }, { env: state.env });
  return withUpdateCommandExecutor(update.runId, async (executor) =>
    run(await executor.enter(state.root, preflight ? { preflight: true } : undefined)),
  );
}

export function singleInstallConfig(
  id: string,
  record: NonNullable<Plugins["installs"]>[string],
  plugins: Omit<Plugins, "installs"> = {},
): OpenClawConfig {
  return { plugins: { ...plugins, installs: { [id]: record } } };
}

export const acceptCapabilities: PluginCapabilityConsentHandler = async ({ reviewToken }) => ({
  reviewToken,
});

export async function snapshotNpmProject(root: string, packageDir: string) {
  const identities = await Promise.all(
    [root, packageDir].map(async (dir) => {
      const stat = await fs.lstat(dir, { bigint: true });
      expect(stat.isDirectory()).toBe(true);
      return [stat.dev, stat.ino];
    }),
  );
  const files = await Promise.all(
    [
      path.join(root, "package.json"),
      path.join(root, "package-lock.json"),
      path.join(packageDir, "package.json"),
      path.join(packageDir, "openclaw.plugin.json"),
      path.join(packageDir, "dist", "index.js"),
    ].map((file) => fs.readFile(file)),
  );
  return { identities, files };
}
