import { once } from "node:events";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { decodeLaunchAgentPlistFixture } from "../../daemon/launchd-plist.test-support.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../../infra/update-npm-prefix.js";
import { recordCommandProcessFailure } from "../../process/exec-result.js";
import type {
  BufferedCommandOptions,
  BufferedCommandResult,
  runCommandWithTimeout,
  runExec,
  runUtf8CommandWithTimeout,
} from "../../process/exec.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";

export function isLegacyUpdateDoctorCommand(argv: readonly string[]) {
  return (
    argv[2] === "doctor" &&
    argv[3] === "--non-interactive" &&
    (argv.length === 4 || argv[4] === "--fix")
  );
}

// WAL/source-inode coverage belongs to the real worker; retain config/drift checks here.
export async function runUpdateBufferedCommandFixture(
  argv: string[],
  options: BufferedCommandOptions = {},
): Promise<BufferedCommandResult> {
  if (argv[0] === "pacman") {
    return pkgQueryResult("", {
      code: null,
      termination: "error",
      error: Object.assign(new Error("pacman is absent in this fixture"), { code: "ENOENT" }),
    });
  }
  if (typeof options.input !== "string") {
    throw new Error("Unexpected buffered update command without snapshot input");
  }
  const input: unknown = JSON.parse(options.input);
  const mode = isRecord(input) ? input.mode : undefined;
  if (mode !== "inventory" && mode !== "snapshot") {
    throw new Error("Unexpected update state worker mode");
  }
  return pkgQueryResult(
    JSON.stringify(
      mode === "inventory"
        ? { databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json" }
        : { versions: [], pluginPaths: {} },
    ),
  );
}

export function createUpdateExecTransportFixture(params: {
  run: typeof runExec;
  nativeRun: typeof runExec;
  hostPlatform: NodeJS.Platform;
  isMacosAclInspection: (command: string, args: readonly string[]) => boolean;
  isPlistStdinConversion: (command: string, args: readonly string[]) => boolean;
}): typeof runExec {
  return async (...args: Parameters<typeof runExec>) => {
    const [command, argv, options] = args;
    if (argv[0] === "-e" && argv[1]?.includes("sqliteSelectionError")) {
      const result = await params.run(...args);
      if (result.stdout.trim() || result.stderr.trim()) {
        return result;
      }
      const executable = path.win32.basename(command).toLowerCase();
      const isBun = executable === "bun" || executable === "bun.exe";
      return {
        stdout: JSON.stringify({
          nodeVersion: process.versions.node,
          bunVersion:
            command === process.execPath ? (process.versions.bun ?? null) : isBun ? "1.4.3" : null,
          sqliteVersion: "3.53.4",
          sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
          sqliteSelectionError: null,
          nodeSharedSqlite: false,
        }),
        stderr: "",
      };
    }
    if (
      params.isPlistStdinConversion(command, argv) &&
      typeof options === "object" &&
      options.input !== undefined
    ) {
      return params.hostPlatform === "darwin"
        ? params.nativeRun(...args)
        : decodeLaunchAgentPlistFixture(options.input, argv[1]);
    }
    return params.isMacosAclInspection(command, argv)
      ? params.nativeRun(...args)
      : params.run(...args);
  };
}

// Fixture-owned effects still use real child admission, PID binding and settlement.
export async function createUpdateCommandTransportFixture(transport: {
  run: typeof runCommandWithTimeout;
  hostCwd: string;
  hostEnv: NodeJS.ProcessEnv;
  npmPrefix: string;
  readServiceCommand?: (env?: NodeJS.ProcessEnv) => Promise<GatewayServiceCommandConfig | null>;
}) {
  const hostPlatform = process.platform;
  const { spawn: spawnChild } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return async (...[argv, options]: Parameters<typeof transport.run>) => {
    const npmProbe = argv.at(-2);
    if (
      (npmProbe === "prefix" || npmProbe === "root") &&
      argv.at(-1) === "-g" &&
      ((argv.length === 3 && argv[0] === "npm") ||
        (argv.length === 4 &&
          argv[0] === process.execPath &&
          path.basename(argv[1] ?? "") === "npm-cli.js"))
    ) {
      const result = await transport.run(argv, options);
      // Both npm probes describe the same empty prefix when an effect double omits metadata.
      if (result.code === 0 && result.stdout === "") {
        const prefix = transport.npmPrefix;
        const root =
          npmProbe === "root" ? resolveNpmGlobalPrefixLayoutFromPrefix(prefix).globalRoot : prefix;
        return { ...result, stdout: `${root}\n` };
      }
      return result;
    }
    if (typeof options === "number" || !options.beforeInput) {
      return transport.run(argv, options);
    }
    // Admission needs a fresh live PID and joined exit, not a Node runtime boot.
    const executable = hostPlatform === "win32" ? process.execPath : "cat";
    const args = hostPlatform === "win32" ? ["-e", "process.stdin.resume()"] : [];
    const child = spawnChild(executable, args, {
      stdio: ["pipe", "ignore", "ignore"],
      cwd: transport.hostCwd,
      env: transport.hostEnv,
      detached: hostPlatform !== "win32",
    });
    const closed = once(child, "close");
    try {
      options.beforeInput(expectDefined(child.pid, "fixture child PID"), child.spawnargs);
      const executorFlagIndex = argv.indexOf("--update-executor");
      if (executorFlagIndex !== -1 && argv[executorFlagIndex + 1] === "check") {
        // A probe must not run the install/restart effect double.
        return commandResult({
          stdout: JSON.stringify({
            updateExecutor: "root-spawner-v1",
            targetRootBinding: true,
            definitionBackup: true,
            retainedOwnerBinding: true,
            originalDefinitionBinding: true,
            originalRuntimePinBinding: true,
          }),
          cleanup: "normal",
        });
      }
      const input: unknown =
        typeof options.input === "string" && options.input ? JSON.parse(options.input) : undefined;
      const originalDefinition = isRecord(input) ? input.originalDefinition : undefined;
      if (typeof originalDefinition === "string") {
        const { fingerprintGatewayServiceDefinition } =
          await import("../../daemon/service-rebind.js");
        const fingerprint = async () =>
          fingerprintGatewayServiceDefinition(
            (await transport.readServiceCommand?.(options.env)) ?? null,
          );
        const before = await fingerprint();
        expect(before).toBe(originalDefinition);
        const { readDaemonRuntimePinForInstall, withDaemonRuntimePinMigration } =
          await import("../../daemon/runtime-pin-state.js");
        const pinRevision = () =>
          readDaemonRuntimePinForInstall({ kind: "gateway", env: options.env ?? {} }, null, true)
            .revision;
        const runtimePinBefore = await withDaemonRuntimePinMigration(
          options.env ?? {},
          pinRevision,
        );
        expect(runtimePinBefore).toBe(isRecord(input) ? input.originalRuntimePin : undefined);
        const result = await transport.run(argv, options);
        // Explicit response fixtures retain malformed/missing-receipt coverage.
        if (result.code !== 0 || result.stdout.trim()) {
          return result;
        }
        const after = await fingerprint();
        return {
          ...result,
          stdout: JSON.stringify({
            rebind: { before, after, runtimePinBefore, runtimePinAfter: pinRevision() },
          }),
        };
      }
      return await transport.run(argv, options);
    } finally {
      child.stdin.end();
      const [code] = await closed;
      expect(code).toBe(0);
    }
  };
}

export async function createUpdateUtf8CommandTransportFixture(
  transport: Parameters<typeof createUpdateCommandTransportFixture>[0] & { exec: typeof runExec },
  run: typeof runUtf8CommandWithTimeout,
): Promise<typeof runUtf8CommandWithTimeout> {
  const hostPlatform = process.platform;
  const { spawnSync: spawnMetadata } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const runDoctorFixture = await createUpdateCommandTransportFixture(transport);
  return async (argv, options) => {
    if (argv[2] === "doctor" && argv[3] === "--repair") {
      try {
        const result = await transport.exec(
          expectDefined(argv[0], "Doctor executable"),
          argv.slice(1),
          options,
        );
        return commandResult({ ...result, cleanup: "normal" });
      } catch (error) {
        // This effect double starts no native child, including on diagnostic failures.
        throw recordCommandProcessFailure(error, {
          code: null,
          cleanup: "normal",
          termination: "exit",
        });
      }
    }
    if (
      argv.length === 3 &&
      argv[2] === "--check" &&
      path.basename(argv[1] ?? "") ===
        path.basename(runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath)
    ) {
      // These CLI fixture packages do not implement the delegated post-core worker.
      return commandResult({ code: 1 });
    }
    if (argv.at(-1) === "--doctor" && typeof options !== "number" && options.beforeInput) {
      const result = await runDoctorFixture(argv, options);
      // runDoctorFixture has joined and checked its real child's exit.
      return { ...result, cleanup: result.cleanup ?? "normal" };
    }
    const stateWorker = argv.some((arg) =>
      /[/\\]update-candidate-state\.worker\.[cm]?[jt]s$/u.test(arg),
    );
    const evalWorker = argv.includes("--eval");
    if ((!evalWorker && !stateWorker) || typeof options === "number" || !options.input) {
      return run(argv, options);
    }
    const input: unknown = JSON.parse(String(options.input));
    if (!isRecord(input)) {
      return run(argv, options);
    }
    const metadataRequest = evalWorker && Array.isArray(input.files);
    const foreignPlatformSqlite =
      process.platform !== hostPlatform &&
      ((evalWorker && typeof input.directory === "string") ||
        (stateWorker &&
          typeof input.stateDir === "string" &&
          [
            "discover",
            "versions",
            "database-backup",
            "database-generations",
            "database-restore-preparation",
          ].includes(String(input.mode))));
    if (!metadataRequest && !foreignPlatformSqlite) {
      return run(argv, options);
    }
    // SQLite workers use the real host executable/VFS even when service tests simulate Windows.
    const { error, status, stdout, stderr } = spawnMetadata(
      expectDefined(argv[0], "metadata executable"),
      argv.slice(1),
      {
        input: options.input,
        timeout: options.timeoutMs,
        cwd: options.cwd ?? transport.hostCwd,
        env: { ...transport.hostEnv, ...options.baseEnv, ...options.env },
        encoding: "utf8",
      },
    );
    if (error) {
      throw error;
    }
    options.onOutputChunk?.(Buffer.from(stdout), "stdout");
    options.onOutputChunk?.(Buffer.from(stderr), "stderr");
    return commandResult({ code: status, stdout, stderr });
  };
}
