import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
const { fixture } = installFreshUpdateFixture();
const packageRelative =
  process.platform === "win32" ? "node_modules/openclaw" : "lib/node_modules/openclaw";
const packageRoot = (prefix: string) => path.join(prefix, packageRelative);
const binRoot = (prefix: string) =>
  process.platform === "win32" ? prefix : path.join(prefix, "bin");
const entrypoint = (root: string) => path.join(root, "openclaw.mjs");
const contents = (root: string) => fs.readFile(entrypoint(root), "utf8");
const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
const opts = { tag: "2026.9.2", json: true, yes: true };
const lastJson = () => vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
const refusal = "global-install-foreign-destination";

async function writePackage(root: string, version: string, label: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  await fs.writeFile(entrypoint(root), `// ${label} deployment\n`);
}

async function writeLauncher(prefix: string, root: string, destination = "") {
  const bin = binRoot(prefix);
  await fs.mkdir(bin, { recursive: true });
  const foreign = ["foreign-launcher", "foreign-live-launcher"].includes(destination);
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
      foreign ? path.join(path.dirname(prefix), "unrelated-launcher") : entrypoint(root),
      path.join(bin, "openclaw"),
    );
  }
}

function expectRefusalMessage(result: unknown, message: string) {
  expect(result).toHaveProperty("failedStep.stderrTail", expect.stringContaining(message));
}

it("keeps npm updates on the resolved installation when another npm prefix is occupied", async () => {
  vi.mocked(packageDestination.inspectNpmGlobalDestination).mockRestore();
  vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockRestore();
  const base = path.dirname(fixture.root);
  const originalPrefix = path.join(base, ".npm-global");
  const foreignPrefix = path.join(base, ".nvm", "versions", "node", "v24.21.0");
  fixture.root = packageRoot(originalPrefix);
  const foreignRoot = packageRoot(foreignPrefix);
  for (const [prefix, root, label] of [
    [originalPrefix, fixture.root, "original"],
    [foreignPrefix, foreignRoot, "unrelated"],
  ] as const) {
    await writePackage(root, "2026.9.3", label);
    await writeLauncher(prefix, root);
  }
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) =>
    createCommandResult({
      stdout: argv.includes("prefix") ? `${foreignPrefix}\n` : "11.10.0\n",
    }),
  );
  vi.spyOn(plugins, "preflightConfiguredNpmPluginTargets").mockResolvedValue([]);

  await updateCommand({ ...opts, dryRun: true });

  expect(lastJson()).toMatchObject({ dryRun: true, root: fixture.root });
  expect([await contents(fixture.root), await contents(foreignRoot)]).toEqual([
    "// original deployment\n",
    "// unrelated deployment\n",
  ]);
});

it.each([
  "foreign",
  "foreign-managed",
  "foreign-sealed",
  "unverified",
  "claimed",
  "foreign-launcher",
  "foreign-live-launcher",
  "prefix-alias",
  "empty",
  "EACCES",
  "unresolved",
  "ENOTDIR",
] as const)(
  "rechecks %s prefix ownership through the retained launcher after a runtime switch",
  async (destination) => {
    vi.mocked(packageDestination.inspectNpmGlobalDestination).mockRestore();
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    const base = path.dirname(fixture.root);
    const oldRoot = fixture.root;
    const managedForeign = ["foreign-managed", "foreign-sealed"].includes(destination);
    const sourcePath = path.join(base, "selected-gateway.service");
    const selected = path.join(base, "selected");
    const prefixAlias = path.join(base, "selected-alias");
    const newRoot = packageRoot(selected);
    const bin = binRoot(selected);
    await fs.mkdir(path.dirname(newRoot), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(entrypoint(oldRoot), "// original deployment\n");
    const separatePackage =
      ["foreign", "unverified", "claimed"].includes(destination) || managedForeign;
    if (separatePackage) {
      await writePackage(newRoot, "2026.8.1", "foreign");
    } else if (
      ["prefix-alias", "foreign-launcher", "foreign-live-launcher"].includes(destination)
    ) {
      await fs.symlink(oldRoot, newRoot, process.platform === "win32" ? "junction" : "dir");
    }
    if (destination === "prefix-alias") {
      await fs.symlink(selected, prefixAlias, process.platform === "win32" ? "junction" : "dir");
    }
    const unresolved = destination === "unresolved";
    const unknown = destination === "EACCES" || destination === "ENOTDIR" || unresolved;
    const unreadable = unknown || destination === "foreign-launcher";
    const unknownCause =
      unresolved || destination === "ENOTDIR" || destination === "foreign-launcher"
        ? "unreadable-layout"
        : "permission";
    if (destination === "foreign-live-launcher") {
      await fs.writeFile(path.join(base, "unrelated-launcher"), "// unrelated launcher\n");
    }
    if (destination !== "empty" && !unknown) {
      await writeLauncher(selected, newRoot, destination);
    }
    if (["claimed", "unverified"].includes(destination) || managedForeign) {
      mockSystemAccountHome();
      vi.stubEnv("OPENCLAW_HOME", undefined);
      vi.stubEnv("OPENCLAW_PROFILE", undefined);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, ".openclaw"));
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, ".openclaw", "openclaw.json"));
      vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(true);
      const serviceRoot = managedForeign ? oldRoot : newRoot;
      const programArguments = [process.execPath, entrypoint(serviceRoot), "gateway"];
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
          readCommand: async () => ({ programArguments, sourcePath }),
        }),
      );
    }
    const foreign =
      managedForeign ||
      ["foreign", "unverified", "foreign-launcher", "foreign-live-launcher"].includes(destination);
    const refused = foreign || unknown;
    const ownership = unreadable ? "unknown" : foreign ? "foreign" : "owned";

    if (destination === "EACCES" || destination === "ENOTDIR") {
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
    const selectedRoot = packageRoot(selectedPrefix);
    vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
      manager: "npm",
      command: "npm",
      globalRoot: unresolved ? null : path.dirname(selectedRoot),
      packageRoot: unresolved ? null : selectedRoot,
      npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" },
    });
    const writes = vi.spyOn(packageUpdate, "runPackageInstallUpdate");
    vi.spyOn(plugins, "preflightConfiguredNpmPluginTargets").mockResolvedValue([]);
    const continuation = updateCommand({ ...opts, dryRun: true });
    if (refused) {
      await expect(continuation).rejects.toMatchObject({
        result: { reason: refusal },
      });
    } else {
      await continuation;
    }
    const result = lastJson();
    if (refused) {
      const destinationFacts = {
        ownership,
        prefix: unresolved ? null : `~${path.sep}selected`,
        runningRoot: `~${path.sep}installation`,
        ...(unreadable ? { cause: unknownCause } : {}),
      };
      expect(result).toMatchObject({
        status: "error",
        reason: refusal,
        failedStep: { failureFacts: [{ code: refusal, destination: destinationFacts }] },
      });
      expect(JSON.stringify(result)).toContain(
        "https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions",
      );
    } else {
      expect(result).toMatchObject({ dryRun: true, root: oldRoot });
    }
    if (separatePackage && destination !== "claimed") {
      const launcher = path.join(bin, process.platform === "win32" ? "openclaw.cmd" : "openclaw");
      const entry = await fs.realpath(entrypoint(newRoot));
      const ownerMessage = managedForeign
        ? `The selected service (${sourcePath}) uses ${entrypoint(oldRoot)}; it does not own this destination.`
        : "No selected managed service could be verified as owning this destination.";
      const alternative =
        !managedForeign || destination === "foreign-sealed"
          ? "Alternatively, ask the destination's deployment owner to resolve its package/launcher and select it for the intended service using their deployment procedure. Do not overwrite it."
          : `Alternatively, if the destination's owner agrees to use it for this service, explicitly select it with \`node ${quote(entry)} gateway install --force --runtime-path ${quote(process.execPath)}\` and rerun the update. This changes the service binding; it does not grant ownership of another deployment's package.`;
      expectRefusalMessage(
        result,
        `Selected npm destination ${selected} is occupied by another OpenClaw installation: package ${newRoot}; launcher ${launcher} -> ${entry}. ${ownerMessage} No installation was attempted. Switch the runtime back and run \`node ${quote(entrypoint(oldRoot))} update\`. ${alternative}`,
      );
    }
    if (unknown) {
      const prefix = unresolved ? "(unresolved installation layout)" : selected;
      expectRefusalMessage(
        result,
        `Selected npm destination ${prefix} could not be inspected (${unknownCause}); ownership is unknown. No installation was attempted. Fix inspection permissions on this prefix for the service account, or restore the selected package layout, then run \`node ${quote(entrypoint(oldRoot))} update\`. Alternatively, ask the deployment owner to verify the layout and explicitly select the intended installation using its existing deployment procedure.`,
      );
    }
    if (refused) {
      await expect(updateCommand(opts)).rejects.toEqual(new ExitError(1));
      expect(lastJson()).toMatchObject({ reason: refusal });
    }
    expect(writes).not.toHaveBeenCalled();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(await contents(oldRoot)).toBe("// original deployment\n");
    if (separatePackage && destination !== "claimed") {
      expect(await contents(newRoot)).toBe("// foreign deployment\n");
    }
  },
);
