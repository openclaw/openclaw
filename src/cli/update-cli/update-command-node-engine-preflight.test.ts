import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as daemonService from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateGlobal from "../../infra/update-global.js";
import { defaultRuntime } from "../../runtime.js";
import { quoteCliArg } from "../quote-cli-arg.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import { runtimeFixture } from "./update-command-fixtures.test-support.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as runtimeRecovery from "./update-command-node-runtime-resolution.js";
import { preparePackageUpdateRuntime } from "./update-command-node-runtime.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const engine = ">=24.22.1 <25 || >=26.12.1";

it.skipIf(process.platform === "win32").each([true, false])(
  "never executes a relative PATH Node, including diagnostics (restart=%s)",
  async (restart) => {
    const current = stubNodeRuntime();
    vi.spyOn(process, "versions", "get").mockReturnValue({ ...current.versions, node: "26.8.2" });
    const workspace = path.join(path.dirname(fixture.root), "workspace");
    const marker = path.join(workspace, "executed");
    const serviceNode = path.join(path.dirname(fixture.root), "service-node", "node");
    fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
    fs.mkdirSync(path.dirname(serviceNode), { recursive: true });
    fs.writeFileSync(serviceNode, "fixture", { mode: 0o755 });
    fs.writeFileSync(
      path.join(workspace, "bin/node"),
      `#!/bin/sh\n: > ${quoteCliArg(marker)}\nexit 1\n`,
      { mode: 0o755 },
    );
    const probe = runtimePaths.resolveNodeRuntimeInfo;
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation((executable, ...args) =>
      executable === serviceNode || executable === current.execPath
        ? Promise.resolve(runtimeFixture("26.8.2", "3.53.0"))
        : probe(executable, ...args),
    );
    const result = await resolvePackageRuntimePreflight({
      engineOnly: true,
      target: { version: "2026.10.9", nodeEngine: engine },
      nodeRunner: serviceNode,
      shouldRestart: restart,
      runtimeRecovery: {
        env: {
          HOME: path.dirname(fixture.root),
          PATH: `${path.relative(process.cwd(), path.join(workspace, "bin"))}${path.delimiter}${path.dirname(current.execPath)}`,
        },
      },
      service: {
        running: true,
        serviceUpdateVerdict: {
          kind: "owned",
          root: fixture.root,
          fingerprint: "fixture",
          refreshDefinition: true,
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  },
);

it.each([
  ["24.22.1", "26.8.2", "26.8.2", true, true, true, true],
  ["26.8.2", "24.22.1", "26.8.2", true, true, true, true],
  ["26.8.2", "26.8.2", "24.22.1", true, true, true, true],
  ["26.8.2", "26.8.2", "26.8.2", true, true, false, true],
  ["26.8.2", "24.22.1", "24.22.1", false, true, false, true],
  ["26.8.2", "24.22.1", "24.22.1", true, false, false, true],
  ["26.8.2", "26.8.2", "24.22.1", true, true, false, false],
] as const)(
  "checks service %s, updater %s, PATH %s (restart=%s, writable=%s, admitted=%s, inherited=%s)",
  async (
    serviceVersion,
    updaterVersion,
    pathVersion,
    restart,
    writable,
    compatible,
    inheritPath,
  ) => {
    const current = stubNodeRuntime();
    vi.spyOn(process, "versions", "get").mockReturnValue({
      ...current.versions,
      node: updaterVersion,
    });
    mockSystemAccountHome();
    vi.stubEnv("OPENCLAW_HOME", undefined);
    const stateDir = path.join(path.dirname(fixture.root), ".openclaw");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    const serviceNode = path.join(path.dirname(fixture.root), "service/bin", executableName);
    const pathNode = path.join(
      path.dirname(fixture.root),
      "Cellar/node",
      pathVersion,
      "bin",
      executableName,
    );
    for (const executable of [serviceNode, pathNode]) {
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "// synthetic executable; runtime probe supplied below\n", {
        mode: 0o755,
      });
    }
    // Guarded bootstrap discovery executes this fixed external probe fixture.
    if (process.platform === "win32" && pathVersion === "24.22.1") {
      fs.copyFileSync(current.execPath, pathNode, fs.constants.COPYFILE_FICLONE);
    } else if (process.platform !== "win32") {
      fs.writeFileSync(
        pathNode,
        `#!${current.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ nodeVersion: pathVersion, sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true } }))});\n`,
        { mode: 0o755 },
      );
    }
    vi.stubEnv("PATH", `${path.dirname(pathNode)}${path.delimiter}${process.env.PATH}`);
    const native = createMockGatewayService({
      isLoaded: async () => true,
      readCommand: async () => ({
        programArguments: [serviceNode, path.join(fixture.root, "openclaw.mjs"), "gateway"],
        sourcePath: path.join(path.dirname(fixture.root), "gateway.service"),
      }),
      readRuntime: async () => ({ status: "running", systemd: { managerUid: 2001 } }),
      readDefinitionMutationCapability: async () =>
        writable ? { kind: "writable" } : { kind: "sealed", reason: "foreign-owner" },
    });
    vi.spyOn(daemonService, "resolveGatewayService").mockReturnValue(native);
    vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(true);
    const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation();
    if (!prepare) {
      throw new Error("Missing update preparation fixture");
    }
    const plan = await servicePlan.resolveManagedServicePackageUpdatePlan({ root: fixture.root });
    vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockImplementation(async () => ({
      service: {
        ...plan.service,
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: true,
      },
      services: new Map(),
      contexts: [await captureTargetDatabaseSchemaContext(process.env)],
      managedEnv: undefined,
    }));
    vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (options) => ({
      ...(await prepare(options)),
      servicePlan: plan,
    }));
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation(async (executable) =>
      runtimeFixture(
        executable === serviceNode
          ? serviceVersion
          : executable === pathNode
            ? pathVersion
            : updaterVersion,
        "3.53.0",
      ),
    );
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      version: "2026.10.9",
      nodeEngine: engine,
    });
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: "2026.10.9" });

    const options = {
      tag: "2026.10.9",
      yes: true,
      json: true,
      restart,
      runtimeRecoveryEnv: {
        ...runtimePaths.buildRuntimeProbeEnv(process.env),
        HOME: process.env.HOME,
        PATH: inheritPath ? process.env.PATH : "",
      },
    };
    if (compatible && serviceVersion === "26.8.2" && updaterVersion === "26.8.2") {
      await updateCommand({ ...options, dryRun: true });
      expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).not.toHaveProperty("failures");
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    }

    // The staging boundary deliberately stops the update before any package mutation.
    await expect(updateCommand(options)).rejects.toBeDefined();

    if (compatible) {
      const selected =
        serviceVersion === "24.22.1"
          ? serviceNode
          : updaterVersion === "24.22.1"
            ? current.execPath
            : pathNode;
      expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ nodeRunner: selected }),
      );
      if (selected === pathNode) {
        const activation = await preparePackageUpdateRuntime({
          root: fixture.root,
          managedServiceNodeRunner: serviceNode,
          managedService: {
            ...plan.service,
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: true,
          },
          packageUpdateNodeRunner: selected,
          packageRuntimeTarget: { version: "2026.10.9", nodeEngine: engine },
          shouldRestart: true,
          opts: { json: true },
          executor: { enter: async () => ({ assertCurrent: () => {} }) },
          timeoutMs: 5_000,
          tag: "2026.10.9",
        });
        expect(activation).toMatchObject({
          ok: true,
          value: { nodeRunner: pathNode, replacedNodeRunner: serviceNode },
        });
      }
    } else {
      const output = JSON.stringify(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]);
      expect(output).toContain("preflight-node-runtime-incompatible");
      expect(output).toContain(`Gateway install root: ${fixture.root}`);
      expect(output).toContain(serviceNode);
      expect(output).toContain(current.execPath);
      expect(output).toContain(inheritPath ? `PATH Node at ${pathNode}` : "PATH Node: not found");
      expect(output).toContain(engine);
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    }
    expect(native.stop).not.toHaveBeenCalled();
  },
);

it.each([
  ["npm", "24.20.0"],
  ["npm", "26.4.0"],
  ["pnpm", "24.21.0"],
  ["bun", "26.10.0"],
] as const)(
  "refuses %s before fresh-profile staging under service Node %s",
  async (manager, version) => {
    stubNodeRuntime();
    const serviceNode = path.join(path.dirname(fixture.root), "nix/store/old-nodejs/bin/node");
    fixture.managedServiceNodeRunner = serviceNode;
    vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue(manager);
    vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
      manager,
      command: manager,
      globalRoot: path.dirname(fixture.root),
      packageRoot: fixture.root,
      ...(manager === "npm"
        ? { npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" } }
        : {}),
    });
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockResolvedValue(
      runtimeFixture(version, "3.53.0"),
    );
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      version: "2026.10.6",
      nodeEngine: engine,
    });
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: "2026.10.6" });
    const provision = vi.spyOn(runtimeRecovery, "resolveTargetNodeRuntime");
    const manifest = fs.readFileSync(path.join(fixture.root, "package.json"));

    await expect(updateCommand({ tag: "2026.10.6", yes: true, json: true })).rejects.toMatchObject({
      code: 1,
    });

    const result = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
    expect(result).toMatchObject({ reason: "preflight-node-runtime-incompatible" });
    const output = JSON.stringify(result);
    expect(output).toContain(`Node ${version}`);
    expect(output).toContain(engine);
    expect(output).toContain("24.22.1");
    expect(output).toContain(serviceNode);
    expect(output).toContain("service definition");
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.root, "package.json"))).toEqual(manifest);
  },
);
