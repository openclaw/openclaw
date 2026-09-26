import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as daemonService from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as updateGlobal from "../../infra/update-global.js";
import * as processExec from "../../process/exec.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
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

it("keeps npm updates on the resolved installation when another npm prefix is occupied", async () => {
  vi.mocked(packageDestination.inspectNpmGlobalDestination).mockRestore();
  vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockRestore();
  const base = path.dirname(fixture.root);
  const originalPrefix = path.join(base, ".npm-global");
  const foreignPrefix = path.join(base, ".nvm", "versions", "node", "v24.21.0");
  const packageRelative =
    process.platform === "win32" ? "node_modules/openclaw" : "lib/node_modules/openclaw";
  fixture.root = path.join(originalPrefix, packageRelative);
  const foreignRoot = path.join(foreignPrefix, packageRelative);
  for (const [prefix, root, contents] of [
    [originalPrefix, fixture.root, "// original deployment\n"],
    [foreignPrefix, foreignRoot, "// unrelated deployment\n"],
  ] as const) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
    );
    await fs.writeFile(path.join(root, "openclaw.mjs"), contents);
    const bin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    await fs.mkdir(bin, { recursive: true });
    if (process.platform === "win32") {
      await fs.writeFile(
        path.join(bin, "openclaw.cmd"),
        '@"%~dp0\\node_modules\\openclaw\\openclaw.mjs" %*\n',
      );
    } else {
      await fs.symlink(path.join(root, "openclaw.mjs"), path.join(bin, "openclaw"));
    }
  }
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) =>
    createCommandResult({
      stdout: argv.includes("prefix") ? `${foreignPrefix}\n` : "11.10.0\n",
    }),
  );
  vi.spyOn(plugins, "preflightConfiguredNpmPluginTargets").mockResolvedValue([]);

  await updateCommand({ tag: "2026.9.2", json: true, yes: true, dryRun: true });

  expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
    expect.objectContaining({ dryRun: true, root: fixture.root }),
  );
  expect(await fs.readFile(path.join(fixture.root, "openclaw.mjs"), "utf8")).toBe(
    "// original deployment\n",
  );
  expect(await fs.readFile(path.join(foreignRoot, "openclaw.mjs"), "utf8")).toBe(
    "// unrelated deployment\n",
  );
});

it.each([
  "foreign",
  "foreign-managed",
  "foreign-sealed",
  "unverified",
  "claimed",
  "foreign-launcher",
  "foreign-live-launcher",
  "owned",
  "prefix-alias",
  "empty",
  "EACCES",
  "EPERM",
  "unresolved",
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
      destination === "foreign-launcher" ||
      destination === "foreign-live-launcher"
    ) {
      await fs.symlink(oldRoot, newRoot, process.platform === "win32" ? "junction" : "dir");
    }
    if (destination === "prefix-alias") {
      await fs.symlink(selected, prefixAlias, process.platform === "win32" ? "junction" : "dir");
    }
    const unresolved = destination === "unresolved";
    const unknown =
      destination === "EACCES" ||
      destination === "EPERM" ||
      destination === "ENOTDIR" ||
      unresolved;
    const unknownCause =
      unresolved || destination === "ENOTDIR" || destination === "foreign-launcher"
        ? "unreadable-layout"
        : "permission";
    if (destination === "foreign-live-launcher") {
      await fs.writeFile(path.join(base, "unrelated-launcher"), "// unrelated launcher\n");
    }
    if (destination !== "empty" && !unknown) {
      if (process.platform === "win32") {
        await fs.writeFile(
          path.join(bin, "openclaw.cmd"),
          destination === "foreign-launcher"
            ? '@"%~dp0\\unrelated-launcher" %*\n'
            : destination === "foreign-live-launcher"
              ? '@"%~dp0\\..\\unrelated-launcher" %*\n'
              : '@"%~dp0\\node_modules\\openclaw\\openclaw.mjs" %*\n',
        );
      } else {
        await fs.symlink(
          destination === "foreign-launcher" || destination === "foreign-live-launcher"
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
      destination === "foreign-launcher" ||
      destination === "foreign-live-launcher";
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
    const selectedPrefix = destination === "prefix-alias" ? prefixAlias : selected;
    const selectedRoot = path.join(
      selectedPrefix,
      process.platform === "win32" ? "node_modules" : "lib/node_modules",
      "openclaw",
    );
    vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
      manager: "npm",
      command: "npm",
      globalRoot: unresolved ? null : path.dirname(selectedRoot),
      packageRoot: unresolved ? null : selectedRoot,
      npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" },
    });
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
      prefix: unresolved ? null : selectedPrefix,
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
                prefix: unresolved ? null : `~${path.sep}selected`,
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
      const prefix = unresolved ? "(unresolved installation layout)" : selected;
      expect(result).toMatchObject({
        failedStep: {
          stderrTail: expect.stringContaining(
            `Selected npm destination ${prefix} could not be inspected (${unknownCause}); ownership is unknown. No installation was attempted. Fix inspection permissions on this prefix for the service account, or restore the selected package layout, then run \`node ${quote(path.join(oldRoot, "openclaw.mjs"))} update\`. Alternatively, ask the deployment owner to verify the layout and explicitly select the intended installation using its existing deployment procedure.`,
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
