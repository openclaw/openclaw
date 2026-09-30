import { openLocalFileSafely } from "../../infra/fs-safe.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type TransferArtifact = {
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
};

type ArtifactTransferRevocationReason =
  | "expired"
  | "owner cancelled"
  | "authorization lost"
  | "released"
  | "shutdown";

export type ArtifactTransferCapability = {
  token: string;
  artifactKey: string;
  artifact: TransferArtifact;
  expiresAtMs: number;
  remainingServes: number;
  active?: ArtifactTransferAuthorization;
  abortController: AbortController;
  stopWatching?: () => void;
  isAuthorized: () => boolean;
  onProgress?: (servedBytes: number) => void;
  onInterrupted?: (servedBytes: number, reason: string) => void;
  revocationReason?: ArtifactTransferRevocationReason;
};

type ArtifactTransferAuthorization = {
  capability: ArtifactTransferCapability;
  abortController: AbortController;
};

export type ArtifactTransferOptions = {
  now?: () => number;
  generateToken?: (bytes: number) => string;
};

export class ArtifactTransferBusyError extends Error {
  constructor() {
    super("Worker artifact transfer is already active");
    this.name = "ArtifactTransferBusyError";
  }
}

export function createArtifactTransferService(options: ArtifactTransferOptions = {}) {
  const now = options.now ?? Date.now;
  const generateToken = options.generateToken ?? generateSecureToken;
  const capabilities = new Map<string, ArtifactTransferCapability>();

  const revokeCapability = (
    capability: ArtifactTransferCapability,
    reason: ArtifactTransferRevocationReason,
  ): void => {
    capability.revocationReason ??= reason;
    if (capabilities.get(capability.token) === capability) {
      capabilities.delete(capability.token);
    }
    capability.stopWatching?.();
    capability.abortController.abort(new Error("Worker artifact transfer authority closed"));
  };

  const hasAuthority = (capability: ArtifactTransferCapability): boolean => {
    try {
      if (
        capabilities.get(capability.token) === capability &&
        capability.expiresAtMs > now() &&
        !capability.abortController.signal.aborted &&
        capability.isAuthorized()
      ) {
        return true;
      }
    } catch {
      // A lost or throwing owner closes the capability; bearer possession cannot revive it.
    }
    revokeCapability(
      capability,
      capability.expiresAtMs <= now() ? "expired" : "authorization lost",
    );
    return false;
  };

  const isCurrent = (authorization: ArtifactTransferAuthorization): boolean =>
    authorization.capability.active === authorization && hasAuthority(authorization.capability);

  return {
    prepare(params: {
      artifact: TransferArtifact;
      artifactKey: string;
      ttlMs: number;
      maxServes: 1 | 3;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
      onProgress?: (servedBytes: number) => void;
      onInterrupted?: (servedBytes: number, reason: string) => void;
    }): { token: string; expiresAtMs: number } {
      if (
        !Number.isSafeInteger(params.artifact.tarballBytes) ||
        params.artifact.tarballBytes < 1 ||
        params.artifact.tarballBytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES ||
        !SHA256_PATTERN.test(params.artifact.tarballSha256) ||
        !SHA256_PATTERN.test(params.artifactKey)
      ) {
        throw new Error("Worker artifact archive is invalid or exceeds the transfer limit");
      }
      const token = generateToken(32);
      if (!TOKEN_PATTERN.test(token) || capabilities.has(token)) {
        throw new Error("Worker artifact transfer token generator returned an invalid bearer");
      }
      registerSecretValueForRedaction(token);
      const capability: ArtifactTransferCapability = {
        token,
        artifactKey: params.artifactKey,
        artifact: { ...params.artifact },
        expiresAtMs: now() + params.ttlMs,
        remainingServes: params.maxServes,
        abortController: new AbortController(),
        isAuthorized: params.isAuthorized,
        onProgress: params.onProgress,
        onInterrupted: params.onInterrupted,
      };
      capabilities.set(token, capability);
      const revokeOwner = () => revokeCapability(capability, "owner cancelled");
      const timeout = setTimeout(() => revokeCapability(capability, "expired"), params.ttlMs);
      timeout.unref();
      params.signal?.addEventListener("abort", revokeOwner, { once: true });
      capability.stopWatching = () => {
        clearTimeout(timeout);
        params.signal?.removeEventListener("abort", revokeOwner);
      };
      if (params.signal?.aborted) {
        revokeOwner();
      }
      if (!hasAuthority(capability)) {
        throw new Error("Worker artifact transfer authority is unavailable");
      }
      return { token, expiresAtMs: capability.expiresAtMs };
    },

    authorize(params: { token: string; artifactKey: string }) {
      const capability = capabilities.get(params.token);
      if (
        !capability ||
        !hasAuthority(capability) ||
        capability.artifactKey !== params.artifactKey
      ) {
        return undefined;
      }
      if (capability.active) {
        throw new ArtifactTransferBusyError();
      }
      capability.remainingServes--;
      const authorization = { capability, abortController: new AbortController() };
      capability.active = authorization;
      return authorization;
    },

    isAuthorizationCurrent: isCurrent,

    authorizationSignal(authorization: ArtifactTransferAuthorization): AbortSignal {
      return AbortSignal.any([
        authorization.capability.abortController.signal,
        authorization.abortController.signal,
      ]);
    },

    async openFile(authorization: ArtifactTransferAuthorization) {
      if (!isCurrent(authorization)) {
        return null;
      }
      const { capability } = authorization;
      // Keep the descriptor from validation through streaming; never reopen a swapped path.
      const { handle, stat } = await openLocalFileSafely({
        filePath: capability.artifact.tarballPath,
      });
      let accepted = false;
      try {
        if (stat.size !== capability.artifact.tarballBytes || !isCurrent(authorization)) {
          return null;
        }
        accepted = true;
        return {
          handle,
          bytes: capability.artifact.tarballBytes,
          sha256: capability.artifact.tarballSha256,
        };
      } finally {
        if (!accepted) {
          await handle.close();
        }
      }
    },

    finish(authorization: ArtifactTransferAuthorization): void {
      if (!isCurrent(authorization)) {
        return;
      }
      const { capability } = authorization;
      if (capability.remainingServes === 0) {
        revokeCapability(capability, "released");
      } else {
        capability.active = undefined;
        authorization.abortController.abort(new Error("Worker artifact transfer attempt closed"));
      }
    },

    revoke(authorizationOrToken: ArtifactTransferAuthorization | string): void {
      const capability =
        typeof authorizationOrToken === "string"
          ? capabilities.get(authorizationOrToken)
          : authorizationOrToken.capability.active === authorizationOrToken
            ? authorizationOrToken.capability
            : undefined;
      if (capability) {
        revokeCapability(capability, "released");
      }
    },

    closeAll(): void {
      for (const capability of capabilities.values()) {
        revokeCapability(capability, "shutdown");
      }
    },
  };
}

export type ArtifactTransferService = ReturnType<typeof createArtifactTransferService>;
