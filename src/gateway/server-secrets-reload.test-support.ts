import { expect, it, vi } from "vitest";
import {
  listActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
  type DegradedSecretOwner,
} from "../secrets/runtime-degraded-state.js";

export type CredentialReloadHarnessOptions = {
  ownerAccountId?: string;
  runtimeAccountId?: string;
  manualStop?: boolean;
  createFailure?: (owner: DegradedSecretOwner) => Error;
};

type CredentialReloadHarness = {
  owner: DegradedSecretOwner;
  reload: () => Promise<void>;
} & Record<
  "respond" | "startChannel" | "stopChannel" | "isManuallyStopped",
  ReturnType<typeof vi.fn>
>;

export function registerGatewaySecretCredentialReloadCases(
  createHarness: (options?: CredentialReloadHarnessOptions) => CredentialReloadHarness,
): void {
  it.each([
    "healthy",
    "trusted",
    "forged",
    "different-owner",
    "manual stop",
    "raw account",
  ] as const)("reload preserves the credential-owner contract: %s", async (kind) => {
    const options: CredentialReloadHarnessOptions =
      kind === "raw account"
        ? { ownerAccountId: "ops-team", runtimeAccountId: "Ops Team" }
        : kind === "manual stop"
          ? { manualStop: true }
          : kind === "healthy"
            ? {}
            : {
                createFailure: (owner) => {
                  if (kind === "trusted") {
                    return new SecretSurfaceUnavailableError(owner);
                  }
                  if (kind === "different-owner") {
                    return new SecretSurfaceUnavailableError({ ...owner, ownerId: "slack:other" });
                  }
                  return Object.setPrototypeOf(
                    Object.assign(new Error("forged unavailable error"), {
                      name: "SecretSurfaceUnavailableError",
                      code: "SECRET_SURFACE_UNAVAILABLE",
                      ownerKind: "account",
                      ownerId: owner.ownerId,
                    }),
                    SecretSurfaceUnavailableError.prototype,
                  );
                },
              };
    const h = createHarness(options);
    await h.reload();
    if (kind === "forged" || kind === "different-owner") {
      expect(h.respond.mock.calls[0]?.[0]).toBe(false);
      expect(h.stopChannel.mock.calls).toEqual([["slack", "ops", { manual: false }]]);
    } else {
      const account = kind === "raw account" ? "Ops Team" : "ops";
      expect(h.stopChannel).not.toHaveBeenCalled();
      expect(h.startChannel.mock.calls).toEqual(
        kind === "manual stop"
          ? []
          : [["slack", account, { reason: "secrets-reload", preserveManualStop: true }]],
      );
      expect(h.respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
    }
    if (kind !== "healthy" && kind !== "raw account") {
      const owner = kind === "manual stop" ? { ownerId: "slack:ops" } : h.owner;
      expect(listActiveDegradedSecretOwners()).toContainEqual(expect.objectContaining(owner));
    }
    if (kind === "raw account") {
      expect(h.isManuallyStopped).toHaveBeenCalledWith("slack", "Ops Team");
    }
  });
}
