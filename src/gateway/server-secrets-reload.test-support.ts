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
  respond: ReturnType<typeof vi.fn>;
  startChannel: ReturnType<typeof vi.fn>;
  stopChannel: ReturnType<typeof vi.fn>;
  isManuallyStopped: ReturnType<typeof vi.fn>;
};

export function registerGatewaySecretCredentialReloadCases(
  createHarness: (options?: CredentialReloadHarnessOptions) => CredentialReloadHarness,
): void {
  const reload = async (options?: CredentialReloadHarnessOptions) => {
    const harness = createHarness(options);
    await harness.reload();
    return harness;
  };
  const expectRecovery = (
    { startChannel, stopChannel, respond }: CredentialReloadHarness,
    accountId: string | null = "ops",
  ) => {
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel.mock.calls).toEqual(
      accountId === null
        ? []
        : [["slack", accountId, { reason: "secrets-reload", preserveManualStop: true }]],
    );
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  };
  it("reinspects a previously degraded account without stopping healthy siblings when config is unchanged", async () => {
    expectRecovery(await reload());
  });

  it("accepts only the same trusted credential owner remaining degraded after reinspection", async () => {
    const harness = await reload({
      createFailure: (degradedOwner) => new SecretSurfaceUnavailableError(degradedOwner),
    });
    expectRecovery(harness);
    expect(listActiveDegradedSecretOwners()).toContainEqual(expect.objectContaining(harness.owner));
  });

  it.each(["forged", "different-owner"] as const)(
    "rejects a %s unavailable error instead of treating account recovery as degraded success",
    async (failureKind) => {
      const { owner, respond, stopChannel } = await reload({
        createFailure: (degradedOwner) =>
          failureKind === "different-owner"
            ? new SecretSurfaceUnavailableError({ ...degradedOwner, ownerId: "slack:other" })
            : Object.setPrototypeOf(
                Object.assign(new Error("forged unavailable error"), {
                  name: "SecretSurfaceUnavailableError",
                  code: "SECRET_SURFACE_UNAVAILABLE",
                  ownerKind: "account",
                  ownerId: degradedOwner.ownerId,
                }),
                SecretSurfaceUnavailableError.prototype,
              ),
      });
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(stopChannel.mock.calls).toEqual([["slack", "ops", { manual: false }]]);
      expect(listActiveDegradedSecretOwners()).toContainEqual(expect.objectContaining(owner));
    },
  );

  it("does not reinspect a degraded account that an operator manually stopped", async () => {
    const harness = await reload({ manualStop: true });
    expectRecovery(harness, null);
    expect(listActiveDegradedSecretOwners()).toContainEqual(
      expect.objectContaining({ ownerId: "slack:ops" }),
    );
  });

  it("recovers the authoritative raw account identity instead of its normalized owner suffix", async () => {
    const harness = await reload({
      ownerAccountId: "ops-team",
      runtimeAccountId: "Ops Team",
    });
    expect(harness.isManuallyStopped).toHaveBeenCalledWith("slack", "Ops Team");
    expectRecovery(harness, "Ops Team");
  });
}
