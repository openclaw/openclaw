import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { formatCliCommand } from "../cli/command-format.js";
import { tryReadJson } from "../infra/json-files.js";
import {
  resolveOpenClawInstallationRootSync,
  resolveOpenClawPackageRootSync,
} from "../infra/openclaw-root.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";
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
  running: InstallationIdentity;
  onReplacement: (fact: GatewayInstallationReplacement) => void;
  replacement?: GatewayInstallationReplacement;
  check?: Promise<void>;
};

// SDK chunks and the Gateway share one process owner without loading restart machinery.
const installationState = resolveGlobalSingleton<{ observer?: InstallationObserver }>(
  Symbol.for("openclaw.gatewayInstallationReplacement"),
  () => ({}),
);

export function registerGatewayInstallationReplacementHandler(
  onReplacement: InstallationObserver["onReplacement"],
): () => void {
  const observer: InstallationObserver = {
    root: gatewayInstallRoot,
    installationRoot: gatewayInstallRoot
      ? resolveOpenClawInstallationRootSync(gatewayInstallRoot, process.argv[1])
      : null,
    running: { version: VERSION, buildId: resolveRuntimeServiceBuildId() },
    onReplacement,
  };
  installationState.observer = observer;
  const releaseSuspension = onGatewaySuspendAdmissionChange((phase) => {
    if (phase !== "accepting") {
      // A host operation may restore the running installation before reopening.
      observer.replacement = undefined;
    }
  });
  return () => {
    releaseSuspension();
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

/** The existing maintenance tick owns disk reads; requests only consume recorded facts. */
export function checkGatewayInstallationReplacement(): Promise<void> {
  const observer = installationState.observer;
  const root = observer?.installationRoot;
  if (
    !observer ||
    !root ||
    !observer.running.buildId ||
    observer.replacement ||
    getGatewaySuspendAdmissionPhase() !== "accepting"
  ) {
    return Promise.resolve();
  }
  if (observer.check) {
    return observer.check;
  }
  // A suspend-and-resume can finish during this read. Do not publish its transient
  // pointer as a replacement, even if admission is open again when the read settles.
  let admissionChanged = false;
  const releaseObservation = onGatewaySuspendAdmissionChange(() => {
    admissionChanged = true;
  });
  observer.check = tryReadJson(path.join(root, "dist", "build-info.json"), {
    maxBytes: 16 * 1024,
  })
    .then((value) => {
      if (admissionChanged) {
        return;
      }
      const metadata = asNullableRecord(value);
      const version = normalizeNullableString(metadata?.version);
      const buildId = normalizeNullableString(metadata?.buildId);
      // npm can temporarily remove or partially replace metadata. Wait for a complete identity.
      if (!version || version.length > 96 || !buildId || buildId.length > 96) {
        return;
      }
      if (version !== observer.running.version || buildId !== observer.running.buildId) {
        recordReplacement(observer, { version, buildId });
      }
    })
    .finally(() => {
      releaseObservation();
      observer.check = undefined;
    });
  return observer.check;
}

type GatewayStaleInstall = {
  error: ErrorShape;
  restartCommand: string;
};

export function classifyGatewayStaleInstall(error: unknown): GatewayStaleInstall | null {
  const observer = installationState.observer;
  const root = observer?.root ?? gatewayInstallRoot;
  const missingRuntime = collectErrorGraphCandidates(error, readErrorCauses).some((candidate) =>
    isMissingRuntimeChunk(candidate, root),
  );
  if (!missingRuntime) {
    return null;
  }
  if (observer) {
    recordReplacement(observer);
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
