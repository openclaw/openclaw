import { describe, expect, it, vi } from "vitest";
import {
  captureGatewayPersonalIdentityBinding,
  closeGatewayPersonalIdentityBindings,
  PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS,
  resolveGatewayPersonalIdentityBinding,
  revokeGatewayPersonalIdentityBindingsForDevice,
  type PersonalIdentityBindingIntent,
  type VerifiedPersonalIdentityBindingSource,
} from "./personal-identity-binding.js";

const nowMs = 1_800_000_000_000;
const device = { deviceId: "device-a", key: "pair-generation-a" } as const;
const source: VerifiedPersonalIdentityBindingSource = {
  ingress: "tailscale-serve",
  authMethod: "tailscale",
  tailscaleLogin: "vitor@example.com",
  sourceClientIp: "100.64.0.10",
  canonicalProfileId: "profile-a",
  device,
  gatewayId: "gateway-boot-a",
  signedAtMs: nowMs,
  verifiedAtMs: nowMs,
};
const bindIntent: PersonalIdentityBindingIntent = {
  mode: "personal-identity",
  provider: "tailscale",
  phase: "bind",
  bindingId: "binding-a",
  issuedAtMs: nowMs,
};
const useIntent: PersonalIdentityBindingIntent = {
  mode: "personal-identity",
  provider: "tailscale",
  phase: "use",
  bindingId: "binding-a",
  profileId: "profile-a",
  gatewayId: "gateway-boot-a",
  issuedAtMs: nowMs,
};

function capture(gateway: object, overrides: Partial<VerifiedPersonalIdentityBindingSource> = {}) {
  return captureGatewayPersonalIdentityBinding(gateway, { ...source, ...overrides }, bindIntent, nowMs);
}

type ResolveOverrides = Partial<
  Omit<Parameters<typeof resolveGatewayPersonalIdentityBinding>[0], "gateway">
>;

function resolve(gateway: object, overrides: ResolveOverrides = {}) {
  return resolveGatewayPersonalIdentityBinding({
    gateway,
    intent: useIntent,
    device,
    gatewayId: "gateway-boot-a",
    isDirectLocal: true,
    isDeviceCurrent: () => true,
    isProfileCurrent: () => true,
    readCurrentTailscaleLogin: async () => "vitor@example.com",
    nowMs,
    ...overrides,
  });
}

describe("gateway personal identity binding owner", () => {
  it("resolves only the canonical profile over a direct-local connection after provider revalidation", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    await expect(resolve(gateway)).resolves.toMatchObject({
      profileId: "profile-a",
      device,
      tailscaleLogin: "vitor@example.com",
      gatewayId: "gateway-boot-a",
    });
  });

  it("requires the actual verified Serve identity and a nonempty canonical profile", () => {
    expect(capture({}, { ingress: "direct-local" as "tailscale-serve" })).toBe(false);
    expect(capture({}, { authMethod: "token" as "tailscale" })).toBe(false);
    expect(capture({}, { canonicalProfileId: " " })).toBe(false);
    expect(capture({}, { tailscaleLogin: " " })).toBe(false);
  });

  it("requires a fresh signed source proof when creating a binding", () => {
    const gateway = {};
    expect(
      captureGatewayPersonalIdentityBinding(
        gateway,
        source,
        bindIntent,
        nowMs + PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS + 1,
      ),
    ).toBe(false);
  });

  it("rejects mismatched intent, Gateway, transport, device generation, or local signature age", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    await expect(resolve(gateway, { isDirectLocal: false })).resolves.toBeUndefined();
    await expect(resolve(gateway, { gatewayId: "gateway-other" })).resolves.toBeUndefined();
    await expect(
      resolve(gateway, { device: { deviceId: device.deviceId, key: "successor-generation" } }),
    ).resolves.toBeUndefined();
    await expect(
      resolve(gateway, {
        intent: { ...useIntent, profileId: "profile-other" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolve(gateway, {
        intent: { ...useIntent, issuedAtMs: nowMs - PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS - 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not revive or revoke a replacement binding after an awaited check", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    let finishDeviceCheck!: (current: boolean) => void;
    const deviceCheck = new Promise<boolean>((resolve) => {
      finishDeviceCheck = resolve;
    });
    const oldCheck = resolve(gateway, { isDeviceCurrent: () => deviceCheck });
    const replacementIntent: PersonalIdentityBindingIntent = {
      ...bindIntent,
      bindingId: "binding-b",
    };
    expect(
      captureGatewayPersonalIdentityBinding(gateway, source, replacementIntent, nowMs),
    ).toBe(true);
    finishDeviceCheck(true);
    await expect(oldCheck).resolves.toBeUndefined();
    await expect(
      resolve(gateway, {
        intent: { ...useIntent, bindingId: "binding-b" },
      }),
    ).resolves.toMatchObject({ profileId: "profile-a", gatewayId: "gateway-boot-a" });
  });

  it("rechecks the binding after provider validation returns", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    const replacementIntent: PersonalIdentityBindingIntent = {
      ...bindIntent,
      bindingId: "binding-b",
    };
    const login = Promise.resolve("vitor@example.com");
    const resolved = resolve(gateway, {
      readCurrentTailscaleLogin: () => {
        void login.then(() => {
          queueMicrotask(() => {
            captureGatewayPersonalIdentityBinding(gateway, source, replacementIntent, nowMs);
          });
        });
        return login;
      },
    });
    await expect(resolved).resolves.toBeUndefined();
    await expect(
      resolve(gateway, {
        intent: { ...useIntent, bindingId: "binding-b" },
      }),
    ).resolves.toMatchObject({ profileId: "profile-a", gatewayId: "gateway-boot-a" });
  });

  it("fails closed and revokes the binding when the paired generation changes", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    await expect(resolve(gateway, { isDeviceCurrent: () => false })).resolves.toBeUndefined();
    await expect(resolve(gateway)).resolves.toBeUndefined();
  });

  it("fails closed and revokes the binding when canonical profile authority changes", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    await expect(resolve(gateway, { isProfileCurrent: () => false })).resolves.toBeUndefined();
    await expect(resolve(gateway)).resolves.toBeUndefined();
  });

  it("revalidates the uncached provider login and revokes on missing or changed identity", async () => {
    const gateway = {};
    const readCurrentTailscaleLogin = vi.fn(async () => "other@example.com");
    expect(capture(gateway)).toBe(true);
    await expect(resolve(gateway, { readCurrentTailscaleLogin })).resolves.toBeUndefined();
    expect(readCurrentTailscaleLogin).toHaveBeenCalledWith("100.64.0.10");
    await expect(resolve(gateway, { readCurrentTailscaleLogin: async () => undefined })).resolves.toBeUndefined();
  });

  it("revokes exact device bindings and closes the whole owner at Gateway shutdown", async () => {
    const gateway = {};
    expect(capture(gateway)).toBe(true);
    revokeGatewayPersonalIdentityBindingsForDevice(gateway, "device-a");
    await expect(resolve(gateway)).resolves.toBeUndefined();

    const anotherGateway = {};
    expect(capture(anotherGateway)).toBe(true);
    closeGatewayPersonalIdentityBindings(anotherGateway);
    await expect(resolve(anotherGateway)).resolves.toBeUndefined();
  });
});
