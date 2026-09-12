// Physical runtime publication remains part of the managed-service maintenance boundary.
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { resolveGatewayProfileSuffix } from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  readWindowsStartupFallbackRuntimeForUpdate,
} from "../../daemon/schtasks-runtime.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { hasNodeErrorCode, isPathInside } from "../../infra/path-guards.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { UpdatePreMutationError } from "./shared.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";

export function observedSystemdManagerUid(state: GatewayServiceState): number | undefined {
  const uid = state.runtime?.systemd?.managerUid;
  return typeof uid === "number" && Number.isInteger(uid) && uid >= 0 && uid < 0xffffffff
    ? uid
    : undefined;
}

export async function isManagedGatewayServiceOffline(
  service: ReturnType<typeof resolveGatewayService>,
  state: GatewayServiceState,
  timeoutMs: number | undefined,
): Promise<boolean> {
  // Enabled systemd units may be manually stopped; loaded LaunchAgents can
  // respawn. Windows needs the live numeric task state, not its last result.
  return (
    state.runtime?.status === "stopped" &&
    (process.platform === "darwin"
      ? state.loadState.status === "not-loaded" ||
        (state.loadState.status === "loaded" &&
          (await service.isEnabled?.({ env: state.env, timeoutMs }).catch(() => undefined)) ===
            false)
      : process.platform === "win32"
        ? isScheduledTaskDefinitelyNotRunning(resolveTaskName(state.env)) ||
          (await readWindowsStartupFallbackRuntimeForUpdate(state.env).catch(() => null))
            ?.status === "stopped"
        : process.platform === "linux")
  );
}

/** Changed runtime artifacts require an offline physical target, not logical
 * ownership of a deployment's current/releases namespace. No service is stopped here. */
export async function withGatewayRuntimeArtifactPublication<T>(
  params: {
    root: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    assertCurrent: () => void;
  },
  publish: (assertPublicationCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const assertCaller = params.assertCurrent;
  assertCaller();
  return await withGatewayServiceOperationLock(params.env, async (assertNative) => {
    const assertCurrent = () => {
      assertCaller();
      assertNative();
    };
    const refuse = (cause?: unknown): never => {
      throw new UpdatePreMutationError(
        "runtime-artifact-publication",
        "Runtime artifacts changed, but the affected Gateway is running or its offline state could not be verified. Run `openclaw gateway status --deep`, stop the affected Gateway through its service owner, and retry the update.",
        { cause },
      );
    };
    const service = resolveGatewayService();
    type PathIdentity = { real: string; stat?: Stats };
    const identity = async (file: string) => {
      const real = await fs.realpath(file);
      assertCurrent();
      const stat = await fs.stat(file);
      assertCurrent();
      return { real, stat };
    };
    const outputIdentity = async (file: string): Promise<PathIdentity> => {
      try {
        return await identity(file);
      } catch (error) {
        assertCurrent();
        if (!hasNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
        // Missing descendants retain their existing ancestor's physical namespace;
        // a dangling symlink cannot attest a disjoint publication destination.
        const present = await fs.lstat(file).catch((statError: unknown) => {
          if (!hasNodeErrorCode(statError, "ENOENT")) {
            throw statError;
          }
          return undefined;
        });
        assertCurrent();
        if (present) {
          throw error;
        }
        const parent = await outputIdentity(path.dirname(file));
        assertCurrent();
        return { real: path.join(parent.real, path.basename(file)) };
      }
    };
    const same = (a: PathIdentity, b: PathIdentity) =>
      a.real === b.real ||
      Boolean(a.stat && b.stat && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino);
    const outputPaths = [
      "dist-runtime",
      path.join("dist", "extensions", "node_modules", "openclaw"),
    ];
    const readInspection = async () => {
      assertCurrent();
      // Parents are stable across publication; output roots themselves are renamed.
      // Record missing descendants too, so creating them cannot redirect a later effect.
      const parents = await Promise.all(
        [
          "",
          "dist",
          path.join("dist", "extensions"),
          path.join("dist", "extensions", "node_modules"),
        ].map((relative) =>
          relative ? outputIdentity(path.join(params.root, relative)) : identity(params.root),
        ),
      );
      assertCurrent();
      if (parents.some((parent) => parent.stat && !parent.stat.isDirectory())) {
        refuse();
      }
      const target = parents[0]!;
      const destinations = await Promise.all(
        outputPaths.map((output) => outputIdentity(path.join(params.root, output))),
      );
      assertCurrent();
      const state = await readGatewayServiceState(service, {
        env: params.env,
        requireEffective: true,
        requireLoadedCommand: true,
        timeoutMs: params.timeoutMs,
      });
      assertCurrent();
      const layout = await summarizeGatewayServiceLayout(state.command);
      assertCurrent();
      const database = await outputIdentity(resolveOpenClawStateSqlitePath(state.env));
      assertCurrent();
      const serviceName =
        process.platform === "darwin"
          ? resolveLaunchAgentLabel(state.env)
          : process.platform === "win32"
            ? resolveTaskName(state.env)
            : resolveSystemdServiceName(state.env);
      const nativeIdentity = stableStringify({
        command: state.command,
        serviceName,
        profile: resolveGatewayProfileSuffix(state.env.OPENCLAW_PROFILE),
        managerUid: observedSystemdManagerUid(state),
      });
      let serving: { root: PathIdentity; entrypoint: PathIdentity } | undefined;
      let disjoint = false;
      if (layout?.packageRootReal && layout.entrypointReal) {
        const [installed, entrypoint] = await Promise.all([
          identity(layout.packageRootReal),
          outputIdentity(layout.entrypointReal),
        ]);
        assertCurrent();
        serving = { root: installed, entrypoint };
        const servingOutputs = await Promise.all(
          outputPaths.map((output) => outputIdentity(path.join(installed.real, output))),
        );
        assertCurrent();
        disjoint =
          !same(target, installed) &&
          !destinations.some(
            (destination) =>
              same(destination, installed) ||
              isPathInside(destination.real, entrypoint.real) ||
              servingOutputs.some(
                (output) =>
                  same(destination, output) ||
                  isPathInside(destination.real, output.real) ||
                  isPathInside(output.real, destination.real),
              ),
          );
      } else if (
        state.command ||
        state.installed ||
        state.loadState.status !== "not-loaded" ||
        !state.runtime?.missingUnit
      ) {
        refuse();
      }
      const absent =
        !state.command &&
        !state.installed &&
        state.loadState.status === "not-loaded" &&
        state.runtime?.missingUnit === true;
      if (
        !disjoint &&
        (state.running ||
          (!absent &&
            (state.loadState.status === "unknown" ||
              (process.platform === "linux" && observedSystemdManagerUid(state) === undefined) ||
              !(await isManagedGatewayServiceOffline(service, state, params.timeoutMs)))))
      ) {
        refuse();
      }
      assertCurrent();
      if (!disjoint) {
        const activeLock = await readActiveGatewayLockIdentity({
          env: state.env,
          requireInspection: true,
        });
        assertCurrent();
        if (activeLock) {
          refuse();
        }
        const port = await resolveUpdatedGatewayRestartPort({
          serviceEnv: state.env,
          serviceCommand: state.command,
        });
        assertCurrent();
        const usage = await probePortUsage(port);
        assertCurrent();
        if (usage !== "free") {
          refuse();
        }
      }
      return { state, disjoint, parents, destinations, database, nativeIdentity, serving };
    };
    const inspect = async () => {
      try {
        return await readInspection();
      } catch (error) {
        assertCurrent();
        if (error instanceof UpdatePreMutationError) {
          throw error;
        }
        return refuse(error);
      }
    };
    const before = await inspect();
    assertCurrent();
    if (before.serving && !before.serving.entrypoint.stat) {
      refuse();
    }
    const assertPublicationCurrent = async () => {
      const current = await inspect();
      assertCurrent();
      const changedIdentity = (previous: PathIdentity, next: PathIdentity) =>
        previous.real !== next.real ||
        Boolean(
          previous.stat &&
          (!next.stat ||
            previous.stat.dev !== next.stat.dev ||
            previous.stat.ino !== next.stat.ino),
        );
      if (
        before.disjoint !== current.disjoint ||
        before.database.real !== current.database.real ||
        before.nativeIdentity !== current.nativeIdentity ||
        before.parents.some((parent, index) => changedIdentity(parent, current.parents[index]!)) ||
        before.destinations.some(
          (destination, index) => destination.real !== current.destinations[index]!.real,
        ) ||
        (before.serving &&
          (!current.serving ||
            changedIdentity(before.serving.root, current.serving.root) ||
            before.serving.entrypoint.real !== current.serving.entrypoint.real ||
            (!before.destinations.some((destination) =>
              isPathInside(destination.real, current.serving!.entrypoint.real),
            ) &&
              changedIdentity(before.serving.entrypoint, current.serving.entrypoint))))
      ) {
        refuse();
      }
      assertCurrent();
    };
    let coordinator: ReturnType<typeof acquireGatewayLifecycleCoordinator> | undefined;
    try {
      try {
        assertCurrent();
        if (!before.disjoint) {
          coordinator = acquireGatewayLifecycleCoordinator({
            databasePath: before.database.real,
            busyTimeoutMs: 0,
          });
        }
        await assertPublicationCurrent();
        assertCurrent();
      } catch (error) {
        assertCurrent();
        if (error instanceof UpdatePreMutationError) {
          throw error;
        }
        refuse(error);
      }
      assertCurrent();
      // The publisher joins its rollback before settling, keeping both exclusions held.
      const result = await publish(assertPublicationCurrent);
      assertCurrent();
      return result;
    } finally {
      coordinator?.release();
    }
  });
}
