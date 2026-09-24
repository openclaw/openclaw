import { once } from "node:events";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { runCommandWithTimeout, runUtf8CommandWithTimeout } from "../../process/exec.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";

export function isLegacyUpdateDoctorCommand(argv: readonly string[]) {
  return (
    argv[2] === "doctor" &&
    argv[3] === "--non-interactive" &&
    (argv.length === 4 || argv[4] === "--fix")
  );
}

// Native effects/results remain fixture-owned. Preserve real child admission,
// PID binding and settlement instead of bypassing the update executor.
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
    if (
      argv.at(-2) === "prefix" &&
      argv.at(-1) === "-g" &&
      ((argv.length === 3 && argv[0] === "npm") ||
        (argv.length === 4 &&
          argv[0] === process.execPath &&
          path.basename(argv[1] ?? "") === "npm-cli.js"))
    ) {
      const result = await transport.run(argv, options);
      // Supply the fixture's inspected empty prefix when an effect double omits read-only metadata.
      return result.code === 0 && result.stdout === ""
        ? { ...result, stdout: `${transport.npmPrefix}\n` }
        : result;
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
        return {
          code: 0,
          stdout: JSON.stringify({
            updateExecutor: "root-spawner-v1",
            targetRootBinding: true,
            definitionBackup: true,
            retainedOwnerBinding: true,
            originalDefinitionBinding: true,
            originalRuntimePinBinding: true,
          }),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit" as const,
          cleanup: "normal" as const,
        };
      }
      const input: unknown =
        typeof options.input === "string" && options.input ? JSON.parse(options.input) : undefined;
      const originalDefinition = isRecord(input) ? input.originalDefinition : undefined;
      if (typeof originalDefinition === "string") {
        const { fingerprintGatewayServiceDefinition } =
          await import("../../daemon/service-rebind.js");
        const before = await fingerprintGatewayServiceDefinition(
          (await transport.readServiceCommand?.(options.env)) ?? null,
        );
        expect(before).toBe(originalDefinition);
        const { readDaemonRuntimePinForInstall } =
          await import("../../daemon/runtime-pin-state.js");
        const pinRevision = () =>
          readDaemonRuntimePinForInstall({ kind: "gateway", env: options.env ?? {} }, null, true)
            .revision;
        const runtimePinBefore = pinRevision();
        expect(runtimePinBefore).toBe(isRecord(input) ? input.originalRuntimePin : undefined);
        const result = await transport.run(argv, options);
        // Explicit response fixtures retain malformed/missing-receipt coverage.
        if (result.code !== 0 || result.stdout.trim()) {
          return result;
        }
        const after = await fingerprintGatewayServiceDefinition(
          (await transport.readServiceCommand?.(options.env)) ?? null,
        );
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
  transport: Parameters<typeof createUpdateCommandTransportFixture>[0],
  run: typeof runUtf8CommandWithTimeout,
): Promise<typeof runUtf8CommandWithTimeout> {
  const { spawnSync: spawnMetadata } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const runDoctorFixture = await createUpdateCommandTransportFixture(transport);
  return async (argv, options) => {
    if (argv.at(-1) === "--doctor" && typeof options !== "number" && options.beforeInput) {
      // Keep Doctor effects fixture-owned without bypassing live child admission.
      const result = await runDoctorFixture(argv, options);
      // The fixture has joined and checked its real child's exit before returning.
      return { ...result, cleanup: result.cleanup ?? "normal" };
    }
    if (argv.includes("--eval") && typeof options !== "number" && options.input) {
      const input: unknown = JSON.parse(String(options.input));
      if (isRecord(input) && Array.isArray(input.files)) {
        // Inspect real fixture metadata using the host transport even while
        // the CLI simulates another service platform or installer environment.
        const metadata = spawnMetadata(
          expectDefined(argv[0], "metadata executable"),
          argv.slice(1),
          {
            input: options.input,
            timeout: options.timeoutMs,
            cwd: transport.hostCwd,
            env: transport.hostEnv,
            encoding: "utf8",
          },
        );
        if (metadata.error) {
          throw metadata.error;
        }
        return commandResult({
          code: metadata.status,
          stdout: metadata.stdout,
          stderr: metadata.stderr,
        });
      }
    }
    return run(argv, options);
  };
}
