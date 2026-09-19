/** Explicit runtime intent, owned by a managed service in the canonical machine-state store. */
import { z } from "zod";
import { resolveConfigPathCandidate } from "../config/paths.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { resolveNodeServiceIdentityEnvironment } from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import type { DaemonRuntimePinSnapshot, DaemonRuntimePinUpdate } from "./runtime-pin-types.js";
import { resolveTaskName } from "./schtasks-layout.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
} from "./service-types.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

const pinSchema = z.object({ runtime: z.enum(["node", "bun"]), path: z.string().min(1) });
const recordSchema = z.object({ version: z.literal(1), pin: pinSchema, definition: z.string() });

type PinScope = { kind: "gateway" | "node"; env: NodeJS.ProcessEnv };
function resolveScope({ kind, env }: PinScope) {
  const nativeEnv = kind === "node" ? { ...env, ...resolveNodeServiceIdentityEnvironment() } : env;
  const name =
    process.platform === "darwin"
      ? resolveLaunchAgentLabel(nativeEnv)
      : process.platform === "win32"
        ? resolveTaskName(nativeEnv).toLowerCase()
        : resolveSystemdServiceName(nativeEnv);
  return {
    key: `daemon-runtime-pin:${sha256Hex(JSON.stringify([kind, process.platform, name, resolveConfigPathCandidate(env)]))}`,
    options: { env },
  };
}
function revision(value: unknown): string {
  return sha256Hex(JSON.stringify(value ?? null));
}
function definition(command: GatewayServiceCommandConfig | null): string | undefined {
  const managed = resolveManagedGatewayServiceCommand(command);
  if (!managed) {
    return undefined;
  }
  return sha256Hex(JSON.stringify([managed.programArguments, managed.workingDirectory ?? null]));
}

/** Missing definitions have no live pin. An altered definition must be intentionally re-pinned. */
export function readDaemonRuntimePin(
  scope: PinScope,
  command: GatewayServiceCommandConfig | null,
): DaemonRuntimePinSnapshot {
  const { key, options } = resolveScope(scope);
  const value = readConfigMachineState<unknown>(key, options, { artifactPreservingReadOnly: true });
  const snapshot: DaemonRuntimePinSnapshot = {
    revision: revision(value),
    stored: value !== undefined,
    definition: definition(command),
  };
  if (value === undefined || !command) {
    return snapshot;
  }
  const record = recordSchema.parse(value);
  if (record.definition !== definition(command)) {
    throw new Error(
      "Managed service changed since its runtime pin was saved. Reinstall with an explicit --runtime or --runtime-path to select runtime intent.",
    );
  }
  return { ...snapshot, pin: record.pin };
}

/** Explicit install selection may replace obsolete metadata without adopting it. */
export function readDaemonRuntimePinForInstall(
  scope: PinScope,
  command: GatewayServiceCommandConfig | null,
  explicit: boolean,
): DaemonRuntimePinSnapshot {
  return {
    ...readDaemonRuntimePin(scope, explicit ? null : command),
    definition: definition(command),
  };
}

/** Called while holding the native service operation lock, before any service side effect. */
export function assertDaemonRuntimePinCurrent(
  scope: PinScope,
  expected: DaemonRuntimePinSnapshot,
): void {
  const { key, options } = resolveScope(scope);
  if (
    revision(
      readConfigMachineState<unknown>(key, options, { artifactPreservingReadOnly: true }),
    ) !== expected.revision
  ) {
    throw new Error("Runtime pin changed during service planning; rerun the install.");
  }
}

/** The native definition is verified by the caller; the synchronous transaction rejects stale writes. */
export function commitDaemonRuntimePin(
  scope: PinScope,
  update: DaemonRuntimePinUpdate,
  command: GatewayServiceCommandConfig | null,
): void {
  const { key, options } = resolveScope(scope);
  if (!update.pin && update.expected.revision === revision(undefined)) {
    assertDaemonRuntimePinCurrent(scope, update.expected);
    return;
  }
  const binding = definition(command);
  if (update.pin && !binding) {
    throw new Error("Cannot save a runtime pin without a managed service definition.");
  }
  updateConfigMachineState<unknown>(
    key,
    (current) => {
      if (revision(current) !== update.expected.revision) {
        throw new Error(
          "Runtime pin changed before persistence; service may have changed, rerun install with an explicit runtime selection.",
        );
      }
      return update.pin
        ? { version: 1, pin: pinSchema.parse(update.pin), definition: binding }
        : undefined;
    },
    options,
  );
}

export function assertDaemonRuntimePinDefinition(
  expected: GatewayServiceCommandConfig,
  actual: GatewayServiceCommandConfig | null,
): void {
  if (definition(expected) !== definition(actual)) {
    throw new Error(
      "Managed service readback differs from the runtime pin plan; pin metadata was not changed.",
    );
  }
}

/** Revalidate the inspected managed definition after acquiring native mutation custody. */
export function assertDaemonRuntimePinPlan(
  expected: DaemonRuntimePinSnapshot,
  command: GatewayServiceCommandConfig | null,
): void {
  if (expected.definition !== definition(command)) {
    throw new Error("Managed service changed during runtime pin planning; rerun the install.");
  }
}
