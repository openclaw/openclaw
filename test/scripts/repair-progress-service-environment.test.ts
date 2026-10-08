import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createServiceProbe } from "../../scripts/e2e/lib/upgrade-survivor/service-probe.mjs";
import {
  resolveOwnedManagedUpdateEnv,
  resolveUpdatedInstallCommandEnv,
} from "../../src/cli/update-cli/update-command-service-env.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  inspectManagedGatewayServiceBeforeUpdate,
} from "../../src/cli/update-cli/update-command-service-plan.js";
import { buildServiceEnvironment } from "../../src/daemon/service-env.js";
import { readGatewayServiceState, resolveGatewayService } from "../../src/daemon/service.js";
import { readSystemdServiceExecStart } from "../../src/daemon/systemd-service-files.js";
import { buildSystemdUnit } from "../../src/daemon/systemd-unit.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const lifetime = createFixtureLifetime();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await lifetime.cleanup();
    cleanup();
  }),
);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function fixture(heapOptions: string, emptyCaller: boolean) {
  const home = fs.realpathSync(dirs.make("service-probe-env-"));
  const bin = path.join(home, "bin"),
    artifacts = path.join(home, "artifacts");
  fs.mkdirSync(artifacts);
  const selector = path.join(home, 'probe artifacts % " quoted');
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: bin + ":" + process.env.PATH,
    npm_config_prefix: home,
    XDG_RUNTIME_DIR: path.join(bin, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + path.join(bin, "runtime/bus"),
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
  };
  if (emptyCaller) {
    env.NODE_OPTIONS = "";
    env.OPENCLAW_TEST_ARTIFACT_ROOT = "";
  }
  const run = async (name: string, command: string, args: string[]) => {
    const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 10_000 });
    fs.writeFileSync(path.join(artifacts, name + ".stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(artifacts, name + ".stderr"), result.stderr ?? "");
    if (result.status !== 0) {
      throw Object.assign(new Error(result.stderr || name + " failed"), {
        command: name,
        exitCode: result.status || 1,
      });
    }
  };
  const setup = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; install_update_restart_systemctl_shim absent',
      "fixture",
      path.resolve("scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh"),
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  expect(setup.status, setup.stderr).toBe(0);
  const manager = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(bin, "systemd-fixture.mjs"), ...args], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
  const systemctl = (...args: string[]) =>
    spawnSync(path.join(bin, "systemctl"), ["--user", ...args], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  const unit = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.mkdirSync(path.join(home, "dist"));
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.8" }),
  );
  const started = path.join(home, "actual-baseline-start.json");
  fs.writeFileSync(
    path.join(home, "dist/index.js"),
    [
      'import fs from "node:fs";',
      fixtureReceiptClientSource(receipts.endpoint),
      "fs.writeFileSync(" + JSON.stringify(started) + ", JSON.stringify({ pid: process.pid }));",
      "sendReceipt(" + JSON.stringify(started) + ', "started");',
      "await awaitRelease(" + JSON.stringify(started) + ', "stop");',
    ].join(String.fromCharCode(10)),
  );
  const preload = path.join(home, "probe space %.mjs");
  fs.writeFileSync(preload, 'process.env.SURVIVOR_PRELOAD_ADMITTED = "yes";');
  const serviceEnv = buildServiceEnvironment({
    env,
    port: 18789,
    platform: "linux",
    runtime: "node",
    extraPathDirs: [bin],
    existingNodeOptions: heapOptions + " --import=" + JSON.stringify(preload),
  });
  expect(serviceEnv.NODE_OPTIONS).toBe(heapOptions);
  const argv = [
    process.execPath,
    "--max-old-space-size=256",
    path.join(home, "dist/index.js"),
    "gateway",
    "--port",
    "18789",
  ];
  const original = buildSystemdUnit({
    programArguments: argv,
    workingDirectory: home,
    environment: serviceEnv,
  });
  fs.writeFileSync(unit, original);
  expect(systemctl("daemon-reload").status).toBe(0);
  // This fixture always has an authored unit. Select it explicitly before any
  // low-level read; a temporary HOME alone does not isolate system-scope discovery.
  const inspect = () =>
    readSystemdServiceExecStart(env, {
      requireEffective: true,
      requireLoaded: true,
      systemdReadTarget: { scope: "user", unitName: "openclaw-gateway.service", unitPath: unit },
    });
  const probe = createServiceProbe({
    run,
    bin,
    artifacts,
    env,
    preload,
    selectors: { OPENCLAW_TEST_ARTIFACT_ROOT: selector },
  });
  const child = (input: NodeJS.ProcessEnv) => {
    const result = spawnSync(
      process.execPath,
      [
        "-p",
        "JSON.stringify({admitted:process.env.SURVIVOR_PRELOAD_ADMITTED,options:process.env.NODE_OPTIONS,selector:process.env.OPENCLAW_TEST_ARTIFACT_ROOT})",
      ],
      { env: input, encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  return {
    home,
    bin,
    artifacts,
    env,
    selector,
    unit,
    original,
    argv,
    serviceEnv,
    started,
    manager,
    systemctl,
    inspect,
    probe,
    child,
  };
}

it.skipIf(process.platform !== "linux").for(["", "--max-old-space-size=256"])(
  "preserves a real running baseline, both phase environments and current-unit cleanup (%s)",
  (heap, { signal }) =>
    lifetime.run(async () => {
      const f = fixture(heap, heap !== "");
      const beforeEnv = { ...f.env };
      try {
        const before = await f.inspect();
        await f.probe.withCaller(async () => {
          expect(f.child(resolveUpdatedInstallCommandEnv({ processEnv: f.env })).admitted).toBe(
            "yes",
          );
          const lost = f.child(
            resolveOwnedManagedUpdateEnv({ processEnv: f.env, serviceEnv: before!.environment! }),
          );
          expect(lost.admitted).toBeUndefined();
          expect(lost.options).toBe(heap);
        });
        expect(f.env).toEqual(beforeEnv);
        expect(f.systemctl("start", "openclaw-gateway.service").status).toBe(0);
        await withinTest(receipts.waitFor(f.started, "started"), signal);
        const baselinePid = JSON.parse(fs.readFileSync(f.started, "utf8")).pid;
        const runtimeBefore = f.manager("runtime").stdout;
        await f.probe.install();
        expect(f.manager("runtime").stdout).toBe(runtimeBefore);
        expect(JSON.parse(fs.readFileSync(f.started, "utf8")).pid).toBe(baselinePid);
        const admitted = await f.inspect();
        expect(admitted?.programArguments).toEqual(f.argv);
        expect(admitted?.workingDirectory).toBe(f.home);
        expect(admitted?.managedOverrides).toEqual({});
        // Bind the test's explicitly created manager namespace; host-wide service
        // discovery is not part of this proof and must not inspect operator units.
        expect(() => assertGatewayServiceManagementAllowedForUpdate(f.env)).toThrow(
          "non-default state dir",
        );
        // Only account home is a fixture input. UID/GID, platform, manager binding,
        // real PID and service custody remain native; no authority guard is mocked.
        const account = os.userInfo();
        const accountHome = vi
          .spyOn(os, "userInfo")
          .mockReturnValue({ ...account, homedir: f.home });
        let state;
        try {
          state = await readGatewayServiceState(resolveGatewayService(), {
            env: f.env,
            systemdInstallation: {
              kind: "user",
              user: { scope: "user", unitName: "openclaw-gateway.service", unitPath: f.unit },
            },
            requireEffective: true,
            requireLoadedCommand: true,
            validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
          });
        } finally {
          accountHome.mockRestore();
        }
        const owned = await inspectManagedGatewayServiceBeforeUpdate({ state, root: f.home });
        expect(
          owned.kind,
          JSON.stringify({
            owned,
            load: state.loadState,
            runtime: state.runtime,
            command: state.command?.programArguments,
          }),
        ).toBe("owned");
        expect(state.runtime?.pid).toBe(baselinePid);
        const timeout = Object.assign(new Error("original timeout"), {
          exitCode: 124,
          processTreeState: "terminated",
        });
        await expect(
          f.probe.withCaller(async () => {
            for (const projected of [
              resolveUpdatedInstallCommandEnv({ processEnv: f.env }),
              resolveOwnedManagedUpdateEnv({
                processEnv: f.env,
                serviceEnv: admitted!.environment!,
              }),
            ]) {
              expect(f.child(projected)).toMatchObject({ admitted: "yes", selector: f.selector });
            }
            throw timeout;
          }),
        ).rejects.toBe(timeout);
        expect(f.env).toEqual(beforeEnv);
        expect(f.systemctl("stop", "openclaw-gateway.service").status).toBe(0);
        await withinTest(receipts.waitForExit(f.started), signal);
        // Model a candidate-repaired generated unit; never restore old whole bytes.
        const repairedArgv = [...f.argv];
        repairedArgv[1] = "--max-old-space-size=384";
        const repaired = buildSystemdUnit({
          programArguments: repairedArgv,
          workingDirectory: f.artifacts,
          environment: { ...admitted!.environment, AFTER_UPDATE: "retained" },
        });
        fs.writeFileSync(f.unit, repaired);
        expect(f.systemctl("daemon-reload").status).toBe(0);
        const failures: unknown[] = [timeout];
        expect(await f.probe.finish({ failures, serviceStopped: true })).toEqual({
          retained: false,
        });
        expect(failures).toEqual([timeout]);
        const restored = await f.inspect();
        expect(restored?.programArguments).toEqual(repairedArgv);
        expect(restored?.workingDirectory).toBe(f.artifacts);
        expect(restored?.environment?.AFTER_UPDATE).toBe("retained");
        expect(restored?.environment?.NODE_OPTIONS).toBe(heap);
        expect(restored?.environment).not.toHaveProperty("OPENCLAW_TEST_ARTIFACT_ROOT");
        expect(fs.readFileSync(f.unit, "utf8")).toBe(
          buildSystemdUnit({
            programArguments: repairedArgv,
            workingDirectory: f.artifacts,
            environment: { ...f.serviceEnv, AFTER_UPDATE: "retained" },
          }),
        );
        expect(fs.existsSync(f.unit + ".d")).toBe(false);
      } finally {
        const stopped = f.systemctl("stop", "openclaw-gateway.service");
        expect(stopped.status, stopped.stderr).toBe(0);
      }
    }),
);

it.skipIf(process.platform !== "linux")(
  "refuses an EnvironmentFile shadow before writing",
  async () => {
    const f = fixture("--max-old-space-size=256", false);
    const environmentFile = path.join(f.home, "service environment %.env");
    const environmentBytes = "NODE_OPTIONS=--max-old-space-size=384\n";
    fs.writeFileSync(environmentFile, environmentBytes);
    const current = buildSystemdUnit({
      programArguments: f.argv,
      workingDirectory: f.home,
      environment: f.serviceEnv,
      environmentFiles: [environmentFile],
    });
    fs.writeFileSync(f.unit, current);
    expect(f.systemctl("daemon-reload").status).toBe(0);
    await expect(f.probe.install()).rejects.toThrow("shadows fixture instrumentation");
    expect(fs.readFileSync(f.unit, "utf8")).toBe(current);
    expect(fs.readFileSync(environmentFile, "utf8")).toBe(environmentBytes);
    expect(fs.existsSync(path.join(f.artifacts, "service-probe-receipt.json"))).toBe(false);
  },
);

it
  .skipIf(process.platform !== "linux")
  .for(["unjoined", "stop-failed", "restore-drift", "missing-receipt"] as const)(
  "retains instrumentation and primary124 on %s",
  async (failure) => {
    const f = fixture("--max-old-space-size=256", false);
    await f.probe.install();
    const primary = Object.assign(new Error("original timeout"), {
      exitCode: 124,
      processTreeState: failure === "unjoined" ? "indeterminate" : "terminated",
    });
    const failures: unknown[] = [primary];
    if (failure === "restore-drift") {
      const current = (await f.inspect())!;
      fs.writeFileSync(
        f.unit,
        buildSystemdUnit({
          programArguments: current.programArguments,
          workingDirectory: current.workingDirectory,
          environment: { ...current.environment, OPENCLAW_TEST_ARTIFACT_ROOT: "changed-selector" },
        }),
      );
      expect(f.systemctl("daemon-reload").status).toBe(0);
    }
    if (failure === "missing-receipt") {
      fs.rmSync(path.join(f.artifacts, "service-probe-receipt.json"));
    }
    const before = fs.readFileSync(f.unit, "utf8");
    expect(await f.probe.finish({ failures, serviceStopped: failure !== "stop-failed" })).toEqual({
      retained: true,
    });
    expect(failures[0]).toBe(primary);
    expect(primary.exitCode).toBe(124);
    expect(failures).toHaveLength(["restore-drift", "missing-receipt"].includes(failure) ? 2 : 1);
    expect(fs.readFileSync(f.unit, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(f.artifacts, "service-probe-receipt.json"))).toBe(
      failure !== "missing-receipt",
    );
  },
);
