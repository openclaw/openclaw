import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileHandleBounded } from "@openclaw/fs-safe/advanced";
import {
  coerceErrorMessage,
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveOpenClawInstallationRootSync,
  resolveOpenClawPackageRootSync,
} from "../infra/openclaw-root.js";
import { acquirePackageReleaseLease } from "../infra/package-release-lease.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import {
  getGatewaySuspendAdmissionPhase,
  onGatewaySuspendAdmissionChange,
} from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { isGatewayTransportError } from "./transport-error.js";

export const GATEWAY_STALE_INSTALL_CLOSE_REASON =
  "gateway install changed; run: openclaw gateway restart";

export type GatewayStaleConnectionReason = "installation-replaced" | "legacy-handler-unavailable";

export function classifyGatewayStaleConnectionError(
  error: unknown,
): GatewayStaleConnectionReason | undefined {
  if (coerceErrorMessage(error).includes(GATEWAY_STALE_INSTALL_CLOSE_REASON)) {
    return "installation-replaced";
  }
  // Published June Gateways report failed runtime imports before STALE_INSTALL existed.
  if (
    isGatewayTransportError(error) &&
    error.kind === "closed" &&
    error.code === 1011 &&
    error.reason === "gateway message handler unavailable"
  ) {
    return "legacy-handler-unavailable";
  }
  return undefined;
}

// The install root is process-stable; capture it before an upgrade can replace
// package metadata, then consult it only after a dynamic import has failed.
const gatewayInstallRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });

type InstallationIdentity = { version: string; buildId: string | null };

export type GatewayInstallationReplacement = {
  running: InstallationIdentity;
  onDisk?: InstallationIdentity;
  detectedAt: number;
  message: string;
  reason: string;
};

type InstallationObserver = {
  root: string | null;
  installationRoot: string | null;
  /** The update lease key of the installation, captured with it. */
  updateKey: string | null;
  running: InstallationIdentity;
  onReplacement: (fact: GatewayInstallationReplacement) => void;
  replacement?: GatewayInstallationReplacement;
  check?: Promise<void>;
  trialSettled?: boolean;
  /** When a check first saw the installation mid-write. */
  unsettledSince?: number;
  /** A request failed to load an own runtime chunk; the next check decides the restart. */
  runtimeMissing?: boolean;
};

// npm retires the old tree, extracts the new one, then lifecycle scripts remove the pending
// marker; a restart before then lands on a half-written tree (#203897). Installs with blocked
// scripts keep the marker until the launcher completes it, so stop waiting after this bound.
const INSTALLATION_SETTLE_MS = 10 * 60_000;

// SDK chunks and the Gateway share one process owner without loading restart machinery.
const installationState = resolveGlobalSingleton<{ observer?: InstallationObserver }>(
  Symbol.for("openclaw.gatewayInstallationReplacement"),
  () => ({}),
);

export function registerGatewayInstallationReplacementHandler(
  onReplacement: InstallationObserver["onReplacement"],
): () => void {
  const installationRoot = gatewayInstallRoot
    ? resolveOpenClawInstallationRootSync(gatewayInstallRoot, process.argv[1])
    : null;
  const observer: InstallationObserver = {
    root: gatewayInstallRoot,
    installationRoot,
    updateKey: installationRoot ? resolveUpdateInstallRoot(installationRoot) : null,
    running: { version: VERSION, buildId: resolveRuntimeServiceBuildId() },
    onReplacement,
  };
  installationState.observer = observer;
  // A Gateway keeps loading files from its release after the link moves on.
  let releaseLease = () => {};
  try {
    releaseLease = gatewayInstallRoot
      ? acquirePackageReleaseLease(gatewayInstallRoot)
      : releaseLease;
  } catch {
    // Without a lease the release still survives collection for 24 hours.
  }
  const releaseSuspension = onGatewaySuspendAdmissionChange((phase) => {
    if (phase !== "accepting") {
      // A host operation may restore the running installation before reopening.
      observer.replacement = undefined;
      observer.runtimeMissing = undefined;
    }
  });
  return () => {
    releaseSuspension();
    try {
      releaseLease();
    } catch {
      // A lease left behind by a stopped Gateway is ignored as soon as its process is gone.
    }
    if (installationState.observer === observer) {
      installationState.observer = undefined;
    }
  };
}

export function getGatewayInstallationReplacement(): GatewayInstallationReplacement | undefined {
  return installationState.observer?.replacement;
}

function recordReplacement(observer: InstallationObserver, onDisk?: InstallationIdentity): void {
  // A live suspension owns installation changes and their stop/restart handoff.
  if (
    installationState.observer !== observer ||
    observer.replacement ||
    getGatewaySuspendAdmissionPhase() !== "accepting"
  ) {
    return;
  }
  const identity = ({ version, buildId }: InstallationIdentity) =>
    `${version} build ${buildId ?? "unknown"}`;
  const message = `Installation replaced: running ${identity(observer.running)}; on-disk ${onDisk ? identity(onDisk) : "runtime chunks unavailable"}.`;
  const fact: GatewayInstallationReplacement = {
    running: observer.running,
    ...(onDisk ? { onDisk } : {}),
    detectedAt: Date.now(),
    message,
    reason: `gateway.installation_replaced: ${message}`,
  };
  observer.replacement = fact;
  observer.onReplacement(fact);
}

async function readInstallationMetadata(file: string): Promise<unknown> {
  try {
    if (!(await fs.lstat(file)).isFile()) {
      return null;
    }
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) {
        return null;
      }
      // This is one bounded observation, not write authority. A later tick observes replacement.
      // Expose only read: fs-safe's optional fd size hint performs synchronous fstat calls.
      const raw = await readFileHandleBounded({ read: handle.read.bind(handle) }, 16 * 1024);
      return JSON.parse(raw.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** The existing maintenance tick owns disk reads; requests only consume recorded facts. */
export function checkGatewayInstallationReplacement(): Promise<void> {
  const observer = installationState.observer;
  // The maintenance owner starts only after the Gateway listener is serving.
  if (observer && !observer.trialSettled) {
    observer.trialSettled = true;
    void import("../update/gateway-trial.js")
      .then(({ announceReady }) => announceReady(observer.running.buildId))
      .catch(() => {
        observer.trialSettled = false;
      });
  }
  const root = observer?.installationRoot;
  if (
    !observer ||
    observer.replacement ||
    getGatewaySuspendAdmissionPhase() !== "accepting" ||
    (!observer.running.buildId && !observer.runtimeMissing)
  ) {
    return Promise.resolve();
  }
  if (!root) {
    // Without an installation root there is no package lifecycle to wait for.
    if (observer.runtimeMissing) {
      recordReplacement(observer);
    }
    return Promise.resolve();
  }
  if (observer.check) {
    return observer.check;
  }
  // A chunk failure during this read is decided by the fresh check its classifier chains.
  const runtimeMissing = observer.runtimeMissing;
  observer.check = readInstallationMetadata(path.join(root, "dist", "build-info.json"))
    .then(async (value) => {
      // Package managers extract the pending marker before build metadata, so reading it
      // after the identity cannot pair a new identity with the previous settled tree.
      const lifecyclePending = await fs
        .access(path.join(root, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH))
        .then(
          () => true,
          () => false,
        );
      const metadata = asNullableRecord(value);
      const version = normalizeNullableString(metadata?.version);
      const buildId = normalizeNullableString(metadata?.buildId);
      // npm can temporarily remove or partially replace metadata. Wait for a complete identity.
      const complete = version && version.length <= 96 && buildId && buildId.length <= 96;
      if (!lifecyclePending && (complete || !observer.running.buildId)) {
        observer.unsettledSince = undefined;
      } else {
        observer.unsettledSince ??= Date.now();
        if (Date.now() - observer.unsettledSince < INSTALLATION_SETTLE_MS) {
          return;
        }
      }
      if (
        complete &&
        observer.running.buildId &&
        (version !== observer.running.version || buildId !== observer.running.buildId) &&
        !(observer.updateKey && (await isInstallationHeldByUpdateRun(observer.updateKey)))
      ) {
        recordReplacement(observer, { version, buildId });
      } else if (runtimeMissing) {
        recordReplacement(observer);
      }
    })
    .finally(() => {
      observer.check = undefined;
    });
  return observer.check;
}

/**
 * The update run owns the installation while it holds the install lease: it stops
 * and restarts this Gateway itself. A self-restart into the new package during the
 * run races its Doctor and Gateway start. A Gateway the run leaves stale restarts on
 * a later check, after the run releases the lease.
 */
async function isInstallationHeldByUpdateRun(installRoot: string): Promise<boolean> {
  try {
    // Lease reads and process probes are synchronous; they run in the handoff worker.
    const [{ prepareManagedHandoffParentStore }, { resolveServiceManagerEnv }] = await Promise.all([
      import("../infra/update-managed-service-handoff-worker.js"),
      import("../daemon/service-process-env.js"),
    ]);
    const store = await prepareManagedHandoffParentStore({
      installRoot,
      serviceManagerEnv: resolveServiceManagerEnv(),
    });
    try {
      const held = await store.read(installRoot);
      if (held.kind !== "current") {
        return false;
      }
      for (const holder of [held.lease.executor, held.lease.helper]) {
        if (await store.isProcessIdentityCurrent(holder)) {
          return true;
        }
      }
      return false;
    } finally {
      await store.close();
    }
  } catch {
    // An unreadable lease cannot hold the installation; keep today's self-restart.
    return false;
  }
}

export function classifyGatewayStaleInstall(error: unknown): {
  error: ErrorShape;
  restartCommand: string;
} | null {
  const observer = installationState.observer;
  const root = observer?.root ?? gatewayInstallRoot;
  const missingRuntime = collectErrorGraphCandidates(error, readErrorCauses).some((candidate) =>
    isMissingRuntimeChunk(candidate, root),
  );
  if (!missingRuntime) {
    return null;
  }
  // A live suspension owns installation changes and may restore the running installation.
  if (observer && !observer.replacement && getGatewaySuspendAdmissionPhase() === "accepting") {
    // The installation may still be mid-write; the owner check restarts once it settles.
    observer.runtimeMissing = true;
    // A check already in flight may have read the flag before it was set.
    void (observer.check ?? Promise.resolve())
      .then(() => checkGatewayInstallationReplacement())
      .catch(() => {
        // The maintenance tick retries the same check.
      });
  }
  const restartCommand = formatCliCommand("openclaw gateway restart");
  return {
    error: errorShape(
      ErrorCodes.UNAVAILABLE,
      `The running Gateway can no longer load part of its OpenClaw installation. The installation may have changed while the Gateway was running. Restart it with: ${restartCommand}`,
      { details: { code: "STALE_INSTALL", restartCommand }, retryable: false },
    ),
    restartCommand,
  };
}

function isMissingRuntimeChunk(error: unknown, root: string | null): boolean {
  if (
    !root ||
    !(error instanceof Error) ||
    !(hasNodeErrorCode(error, "ERR_MODULE_NOT_FOUND") || hasNodeErrorCode(error, "ENOENT"))
  ) {
    return false;
  }
  const { url, path: errorPath } = error as Error & { url?: unknown; path?: unknown };
  let missingPath: string;
  try {
    missingPath =
      typeof url === "string" ? fileURLToPath(url) : typeof errorPath === "string" ? errorPath : "";
  } catch {
    return false;
  }
  return (
    path.isAbsolute(missingPath) &&
    isPathInside(root, missingPath) &&
    /^(?:dist|src)[/\\].*\.[cm]?js$/u.test(path.relative(root, missingPath))
  );
}
