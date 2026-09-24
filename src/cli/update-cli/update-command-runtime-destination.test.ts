import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as daemonService from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import * as processExec from "../../process/exec.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageDestination from "./update-command-package-destination.js";
import * as packageUpdate from "./update-command-package.js";
import * as plugins from "./update-command-plugin-preflight.js";
import {
  unsupportedServiceRuntimeFixture,
  expectedRuntimeSelectionCommand,
} from "./update-command-runtime-recovery.test-support.js";
import * as servicePlan from "./update-command-service-plan.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
const { fixture } = installFreshUpdateFixture();

it.each(["forced", "uncertain"] as const)(
  "settles npm destination inspection before publishing refusal (%s)",
  async (cleanupResult) => {
    vi.mocked(packageDestination.inspectNpmGlobalDestination).mockRestore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const joining = createDeferredCore();
    const writes = vi.spyOn(packageUpdate, "runPackageInstallUpdate");
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => {
      expect(argv).toContain("prefix");
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
      throw new Error("npm prefix probe cancelled");
    });
    const launcher = path.join(fixture.root, "openclaw.mjs");
    await fs.writeFile(launcher, "// original deployment\n");
    const work = updateCommand({ tag: "2026.9.2", json: true, yes: true, dryRun: true }).catch(
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        joining.promise,
        work.then(() => {
          throw new Error("npm destination refusal escaped cleanup ownership");
        }),
      ]);
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(defaultRuntime.error).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        reason:
          cleanupResult === "uncertain"
            ? "update-admission-cleanup-failed"
            : "global-install-foreign-destination",
        failedStep: expect.objectContaining({
          failureFacts: [expect.objectContaining({ code: "global-install-foreign-destination" })],
        }),
        ...(cleanupResult === "uncertain"
          ? { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } }
          : {}),
      }),
    );
    if (cleanupResult === "uncertain") {
      expect(await work).toEqual(new ExitError(1));
    } else {
      expect(await work).toMatchObject({
        result: { reason: "global-install-foreign-destination" },
      });
    }
    expect(writes).not.toHaveBeenCalled();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(await fs.readFile(launcher, "utf8")).toBe("// original deployment\n");
  },
);

it.each([
  "foreign",
  "foreign-managed",
  "foreign-sealed",
  "unverified",
  "claimed",
  "foreign-launcher",
  "owned",
  "prefix-alias",
  "empty",
  "EACCES",
  "EPERM",
  "probe-failure",
  "probe-empty",
  "probe-relative",
  "ENOTDIR",
] as const)(
  "rechecks %s prefix ownership through the retained launcher after a runtime switch",
  async (destination) => {
    vi.mocked(packageDestination.inspectNpmGlobalDestination).mockRestore();
    const inspection = vi.spyOn(packageDestination, "inspectNpmGlobalDestination");
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    const base = path.dirname(fixture.root);
    const oldRoot = fixture.root;
    const managedForeign = destination === "foreign-managed" || destination === "foreign-sealed";
    const selected = path.join(base, "selected");
    const prefixAlias = path.join(base, "selected-alias");
    const newRoot = path.join(
      selected,
      process.platform === "win32" ? "node_modules" : "lib/node_modules",
      "openclaw",
    );
    const bin = process.platform === "win32" ? selected : path.join(selected, "bin");
    await fs.mkdir(path.dirname(newRoot), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(oldRoot, "openclaw.mjs"), "// original deployment\n");
    if (
      destination === "foreign" ||
      destination === "unverified" ||
      destination === "claimed" ||
      managedForeign
    ) {
      await fs.mkdir(newRoot);
      await fs.writeFile(
        path.join(newRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.8.1" }),
      );
      await fs.writeFile(path.join(newRoot, "openclaw.mjs"), "// foreign deployment\n");
    } else if (
      destination === "owned" ||
      destination === "prefix-alias" ||
      destination === "foreign-launcher"
    ) {
      await fs.symlink(oldRoot, newRoot, process.platform === "win32" ? "junction" : "dir");
    }
    if (destination === "prefix-alias") {
      await fs.symlink(selected, prefixAlias, process.platform === "win32" ? "junction" : "dir");
    }
    const probeFailure = destination.startsWith("probe-");
    const unknown =
      destination === "EACCES" ||
      destination === "EPERM" ||
      destination === "ENOTDIR" ||
      probeFailure;
    const unknownCause = probeFailure
      ? "probe-failure"
      : destination === "ENOTDIR" || destination === "foreign-launcher"
        ? "unreadable-layout"
        : "permission";
    if (destination !== "empty" && !unknown) {
      if (process.platform === "win32") {
        await fs.writeFile(
          path.join(bin, "openclaw.cmd"),
          destination === "foreign-launcher"
            ? '@"%~dp0\\unrelated-launcher" %*\n'
            : '@"%~dp0\\node_modules\\openclaw\\openclaw.mjs" %*\n',
        );
      } else {
        await fs.symlink(
          destination === "foreign-launcher"
            ? path.join(base, "unrelated-launcher")
            : path.join(newRoot, "openclaw.mjs"),
          path.join(bin, "openclaw"),
        );
      }
    }
    if (destination === "claimed" || destination === "unverified" || managedForeign) {
      mockSystemAccountHome();
      vi.stubEnv("OPENCLAW_HOME", undefined);
      vi.stubEnv("OPENCLAW_PROFILE", undefined);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, ".openclaw"));
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, ".openclaw", "openclaw.json"));
      vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(true);
      vi.spyOn(daemonService, "resolveGatewayService").mockReturnValue(
        createMockGatewayService({
          isLoaded: async () => true,
          readRuntime: async () => ({
            status: destination === "unverified" ? "unknown" : "stopped",
            systemd: { managerUid: 2001 },
          }),
          readDefinitionMutationCapability: async () =>
            destination === "foreign-sealed"
              ? { kind: "sealed", reason: "sealed-mount" }
              : { kind: "writable" },
          readCommand: async () => ({
            programArguments: [
              process.execPath,
              path.join(managedForeign ? oldRoot : newRoot, "openclaw.mjs"),
              "gateway",
            ],
            sourcePath: path.join(base, "selected-gateway.service"),
          }),
        }),
      );
    }
    const foreign =
      managedForeign ||
      destination === "foreign" ||
      destination === "unverified" ||
      destination === "foreign-launcher";
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockResolvedValue(
      unsupportedServiceRuntimeFixture,
    );
    const beforeSwitch = await resolvePackageRuntimePreflight({
      root: oldRoot,
      target: { version: "2026.9.2", nodeEngine: ">=24.16.0" },
      nodeRunner: "/home/operator/.nvm/versions/node/v22.18.0/bin/node",
      shouldRestart: false,
    });
    const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
    expect(beforeSwitch.recoverySteps).toEqual([
      {
        kind: "preserve-context",
        instruction:
          "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
      },
      { kind: "select-runtime", command: expectedRuntimeSelectionCommand("nvm", "24.16.0") },
      {
        kind: "continue-update",
        command: `node ${quote(path.join(oldRoot, "openclaw.mjs"))} update --tag 2026.9.2`,
      },
    ]);

    if (destination === "EACCES" || destination === "EPERM" || destination === "ENOTDIR") {
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation((...args) =>
        String(args[0]) === newRoot
          ? Promise.reject(
              Object.assign(new Error("Destination access denied"), {
                code: destination,
                path: newRoot,
              }),
            )
          : lstat(...args),
      );
    }
    // The operator has selected the new runtime; only now can npm resolve its destination.
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) =>
      createCommandResult({
        code: destination === "probe-failure" && argv.includes("prefix") ? 1 : 0,
        stdout:
          argv.includes("prefix") && destination !== "probe-empty"
            ? destination === "probe-relative"
              ? "relative/prefix\n"
              : `${destination === "prefix-alias" ? prefixAlias : selected}\n`
            : "",
      }),
    );
    const writes = vi.spyOn(packageUpdate, "runPackageInstallUpdate");
    vi.spyOn(plugins, "preflightConfiguredNpmPluginTargets").mockResolvedValue([]);
    const continuation = updateCommand({ tag: "2026.9.2", json: true, yes: true, dryRun: true });
    if (foreign || unknown) {
      await expect(continuation).rejects.toMatchObject({
        result: { reason: "global-install-foreign-destination" },
      });
    } else {
      await continuation;
    }
    const result = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
    await expect(inspection.mock.results[0]?.value).resolves.toMatchObject({
      kind:
        unknown || destination === "foreign-launcher"
          ? "unknown"
          : foreign
            ? "foreign"
            : destination === "empty"
              ? "empty"
              : "owned",
      prefix: probeFailure ? null : destination === "prefix-alias" ? prefixAlias : selected,
      ...(unknown || destination === "foreign-launcher" ? { cause: unknownCause } : {}),
    });
    if (foreign || unknown) {
      expect(result).toMatchObject({
        status: "error",
        reason: "global-install-foreign-destination",
        failedStep: {
          failureFacts: [
            expect.objectContaining({
              code: "global-install-foreign-destination",
              destination: expect.objectContaining({
                ownership: unknown || destination === "foreign-launcher" ? "unknown" : "foreign",
                prefix: probeFailure ? null : `~${path.sep}selected`,
                runningRoot: `~${path.sep}installation`,
              }),
            }),
          ],
        },
      });
      expect(JSON.stringify(result)).toContain(
        "https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions",
      );
    } else {
      expect(result).toMatchObject({ dryRun: true, root: oldRoot });
    }
    if (destination === "foreign" || destination === "unverified") {
      const launcher = path.join(bin, process.platform === "win32" ? "openclaw.cmd" : "openclaw");
      const entry = await fs.realpath(path.join(newRoot, "openclaw.mjs"));
      expect(result).toMatchObject({
        failedStep: {
          stderrTail: expect.stringContaining(
            `Selected npm destination ${selected} is occupied by another OpenClaw installation: package ${newRoot}; launcher ${launcher} -> ${entry}. No selected managed service could be verified as owning this destination. No installation was attempted. Switch the runtime back and run \`node ${quote(path.join(oldRoot, "openclaw.mjs"))} update\`. Alternatively, ask the destination's deployment owner to resolve its package/launcher and select it for the intended service using their deployment procedure. Do not overwrite it.`,
          ),
        },
      });
    }
    if (managedForeign) {
      const launcher = path.join(bin, process.platform === "win32" ? "openclaw.cmd" : "openclaw");
      const entry = await fs.realpath(path.join(newRoot, "openclaw.mjs"));
      const alternative =
        destination === "foreign-sealed"
          ? "Alternatively, ask the destination's deployment owner to resolve its package/launcher and select it for the intended service using their deployment procedure. Do not overwrite it."
          : `Alternatively, if the destination's owner agrees to use it for this service, explicitly select it with \`node ${quote(entry)} gateway install --force --runtime-path ${quote(process.execPath)}\` and rerun the update. This changes the service binding; it does not grant ownership of another deployment's package.`;
      expect(result).toMatchObject({
        failedStep: {
          stderrTail: expect.stringContaining(
            `Selected npm destination ${selected} is occupied by another OpenClaw installation: package ${newRoot}; launcher ${launcher} -> ${entry}. The selected service (${path.join(base, "selected-gateway.service")}) uses ${path.join(oldRoot, "openclaw.mjs")}; it does not own this destination. No installation was attempted. Switch the runtime back and run \`node ${quote(path.join(oldRoot, "openclaw.mjs"))} update\`. ${alternative}`,
          ),
        },
      });
    }
    if (unknown) {
      const prefix = probeFailure ? "(unresolved; npm prefix -g)" : selected;
      expect(result).toMatchObject({
        failedStep: {
          stderrTail: expect.stringContaining(
            `Selected npm destination ${prefix} could not be inspected (${unknownCause}); ownership is unknown. No installation was attempted. Fix inspection permissions on this prefix for the service account, or make \`npm prefix -g\` succeed with the selected runtime, then run \`node ${quote(path.join(oldRoot, "openclaw.mjs"))} update\`. Alternatively, ask the deployment owner to verify the layout and explicitly select the intended installation using its existing deployment procedure.`,
          ),
        },
      });
    }
    if (foreign || unknown) {
      await expect(updateCommand({ tag: "2026.9.2", json: true, yes: true })).rejects.toEqual(
        new ExitError(1),
      );
      expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "global-install-foreign-destination" }),
      );
    }
    expect(writes).not.toHaveBeenCalled();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(oldRoot, "openclaw.mjs"), "utf8")).toBe(
      "// original deployment\n",
    );
    if (destination === "foreign" || destination === "unverified" || managedForeign) {
      expect(await fs.readFile(path.join(newRoot, "openclaw.mjs"), "utf8")).toBe(
        "// foreign deployment\n",
      );
    }
  },
);
