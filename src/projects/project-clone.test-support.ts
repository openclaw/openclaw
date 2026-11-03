import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeGitCommand, requireGitCommandOutput } from "../infra/git-exec.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { ManagedProjectSourceV1 } from "./managed-project-source.js";
import {
  configureProjectCheckoutMaintenance,
  projectCheckoutGitEnvironment,
} from "./project-checkout-maintenance.js";
import {
  materializeProjectClone as materialize,
  refreshProjectClone as refresh,
} from "./project-clone.js";

type Options = Parameters<typeof materialize>[1];
const { parseProjectGitUrl, resolveConfiguredGitHubHost } = await loadBundledPluginFacade<{
  parseProjectGitUrl(url: string, host?: string): { url: string; name: string } | null;
  resolveConfiguredGitHubHost(config: OpenClawConfig): string;
}>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });

/** Local Git substitutes transport only; the native custodian owns leases and registration. */
export function createProjectCloneSourceFixture(
  config: OpenClawConfig = {},
): ManagedProjectSourceV1 {
  const git = async (
    target: string,
    args: string[],
    options: Parameters<ManagedProjectSourceV1["clone"]>[1],
  ) => {
    options.assertCurrent();
    const result = await executeGitCommand(target, args, {
      env: projectCheckoutGitEnvironment(options.env),
      killProcessTree: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      beforeRun: options.assertCurrent,
    });
    options.assertCurrent();
    return requireGitCommandOutput("fixture Git transport", result);
  };
  return {
    resolveUrl: (url) => parseProjectGitUrl(url, resolveConfiguredGitHubHost(config)),
    invalidUrlMessage:
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    async clone(input, options) {
      options.assertCurrent();
      await fs.mkdir(path.dirname(input.target), { recursive: true });
      await git(path.dirname(input.target), ["clone", "--", input.url, input.target], options);
      if (input.requiredCommit) {
        await git(
          input.target,
          ["fetch", "--no-auto-maintenance", "--", input.url, input.requiredCommit],
          options,
        );
        await git(input.target, ["checkout", "--detach", input.requiredCommit], options);
      }
      await configureProjectCheckoutMaintenance(input.target, options);
    },
    async ensureCommit(input, options) {
      await git(
        input.target,
        ["fetch", "--no-auto-maintenance", "--", input.url, input.commit],
        options,
      );
    },
    async refresh(input, options) {
      await git(
        input.target,
        [
          "fetch",
          "--no-auto-maintenance",
          "--prune",
          "--",
          input.url,
          "+refs/heads/*:refs/remotes/origin/*",
        ],
        options,
      );
      await configureProjectCheckoutMaintenance(input.target, options);
    },
    async resolveBase() {
      throw new Error("Native custody fixture does not resolve source-owned base facts");
    },
  };
}

export function materializeProjectClone(
  input: Parameters<typeof materialize>[0],
  options: Options = {},
  transport: Parameters<typeof materialize>[2] = createProjectCloneSourceFixture(input.cfg),
) {
  return materialize(input, options, transport);
}
export function refreshProjectClone(project: Parameters<typeof refresh>[0], options: Options = {}) {
  return refresh(project, options, createProjectCloneSourceFixture());
}
