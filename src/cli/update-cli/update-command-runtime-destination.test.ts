import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { expect, it, vi, type MockInstance } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as daemonService from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as activationPaths from "../../infra/package-update-activation-paths.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import * as processExec from "../../process/exec.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { registerUpdateCli } from "../update-cli.js";
import * as shared from "./shared.js";
import { runtimeFixture } from "./update-command-fixtures.test-support.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageDestination from "./update-command-package-destination.js";
import * as packageUpdate from "./update-command-package.js";
import * as plugins from "./update-command-plugin-preflight.js";
import * as commandRun from "./update-command-run.js";
import * as runtimePlan from "./update-command-runtime-preflight.js";
import { unsupportedServiceRuntimeFixture } from "./update-command-runtime-recovery.test-support.js";
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
  await writeFixtureJson(path.join(root, "package.json"), { name: "openclaw", version });
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
    if (refused) {
      expectRefusalMessage(result, `node ${quote(entrypoint(oldRoot))} update`);
      if (separatePackage) {
        expectRefusalMessage(result, newRoot);
        expectRefusalMessage(result, managedForeign ? sourcePath : "No selected managed service");
        expectRefusalMessage(
          result,
          destination === "foreign-managed"
            ? `node ${quote(await fs.realpath(entrypoint(newRoot)))} gateway install --force --runtime-path ${quote(process.execPath)}`
            : "Do not overwrite it.",
        );
      }
      if (unknown) {
        expectRefusalMessage(result, "Fix inspection permissions");
      }
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

const lastJsonCall = () => vi.mocked(defaultRuntime.writeJson).mock.lastCall;
function preflightOutcome(
  preflight: MockInstance<typeof runtimePlan.resolvePackageRuntimePreflight>,
) {
  const result = expectDefined(preflight.mock.results.at(-1), "runtime refusal");
  if (result.type !== "return") {
    throw new Error("Runtime preflight did not return its outcome");
  }
  return result.value;
}

it.each([
  ["extended-stable", "2026.8.33", "--channel extended-stable", null],
  ["beta", "2026.9.4-beta.1", "--tag 2026.9.4-beta.1", null],
  ["dev", "2026.9.4-dev.1", "--tag 2026.9.4-dev.1", null],
  ["stable", "2026.8.33", "--channel extended-stable", "extended-stable"],
  ["extended-stable", "2026.9.4-beta.1", "--channel beta --tag 2026.9.4-beta.1", "beta"],
] as const)(
  "replays runtime recovery for saved %s (%s, %s, requested=%s) through the target resolver",
  async (channel, version, selector, requestedChannel) => {
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    const configPath = expectDefined(process.env.OPENCLAW_CONFIG_PATH, "isolated config path");
    fsSync.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = JSON.stringify({ update: { channel } });
    fsSync.writeFileSync(configPath, config);
    fixture.managedServiceNodeRunner = "/home/operator/.nvm/versions/node/v22.18.0/bin/node";
    const captureRuntime = activationPaths.capturePackageActivationRuntime;
    vi.spyOn(activationPaths, "capturePackageActivationRuntime").mockImplementation(
      (kind, executable) =>
        executable === fixture.managedServiceNodeRunner
          ? { kind, path: executable, identity: "synthetic-service-node" }
          : captureRuntime(kind, executable),
    );
    const prepare = expectDefined(
      vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation(),
      "fixture preparation",
    );
    vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (options) => ({
      ...(await prepare(options)),
      requestedChannel: normalizeUpdateChannel(options.channel),
    }));
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockImplementation(async () => ({
      ...targetMetadata,
      version,
      nodeEngine: ">=24.16.0",
    }));
    vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({ tag: channel, version });
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version });
    const runtime = vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo");
    runtime.mockResolvedValue(unsupportedServiceRuntimeFixture);
    const preflight = vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight");

    const options = {
      admission: "installed" as const,
      channel: requestedChannel ?? undefined,
      json: true,
      yes: true,
      restart: false,
      ...(channel === "dev" ? { tag: version } : {}),
    };
    await updateCommand({ ...options, dryRun: true });

    const runtimeRefusal = await preflightOutcome(preflight);
    expect(runtimeRefusal.ok).toBe(false);
    expect(lastJsonCall()).toMatchObject([
      {
        storedChannel: channel,
        targetVersion: version,
        failures: [expect.objectContaining({ reason: "preflight-node-runtime-incompatible" })],
      },
    ]);
    await expect(updateCommand(options)).rejects.toBeInstanceOf(Error);
    const mutableRefusal = await preflightOutcome(preflight);
    expect(mutableRefusal.recoverySteps).toEqual(runtimeRefusal.recoverySteps);
    const continuation = expectDefined(
      runtimeRefusal.recoverySteps?.find((step) => step.kind === "continue-update"),
      "retained-launcher continuation",
    );
    if (!("command" in continuation)) {
      throw new Error("Runtime recovery did not provide a continuation command");
    }
    const command = continuation.command;
    const launcher = `node ${quote(path.join(fixture.root, "openclaw.mjs"))} `;
    expect(command.slice(0, launcher.length)).toBe(launcher);
    runtime.mockResolvedValue(runtimeFixture("26.1.0", "3.53.0"));
    const program = new Command();
    registerUpdateCli(program);

    const replayArgs = command.slice(launcher.length).split(" ");
    await program.parseAsync([...replayArgs, "--dry-run", "--json", "--yes", "--no-restart"], {
      from: "user",
    });

    expect(lastJsonCall()).toMatchObject([
      {
        effectiveChannel: requestedChannel ?? channel,
        targetVersion: version,
      },
    ]);
    expect(lastJsonCall()?.[0]).not.toHaveProperty("failures");
    expect(command).toBe(`${launcher}update ${selector}`);
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(fsSync.readFileSync(configPath, "utf8")).toBe(config);
  },
);
