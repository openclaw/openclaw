import { describe, expect, it, vi } from "vitest";
import { resolveCliBackendAuthForwarding } from "./cli-backend-auth-forwarding.js";

const context = {
  backendId: "example-cli",
  provider: "example-provider",
  modelId: "example-model",
  profileId: "example-provider:user@example.com",
  credential: {
    type: "oauth" as const,
    provider: "example-provider",
    access: "raw-access-token",
  },
};

const policy = {
  supported: true as const,
  providers: ["example-provider"],
  credentialKinds: ["oauth" as const],
};

describe("CLI backend auth forwarding contract", () => {
  it("requires explicit backend opt-in", async () => {
    await expect(
      resolveCliBackendAuthForwarding({
        context,
        resolver: vi.fn(),
      }),
    ).resolves.toEqual({ status: "not-supported" });
  });

  it("fails closed when the selected provider is not allowlisted", async () => {
    await expect(
      resolveCliBackendAuthForwarding({
        policy: { ...policy, providers: ["other-provider"] },
        context,
        resolver: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "provider-denied",
      provider: "example-provider",
    });
  });

  it("fails closed when the raw credential kind is not allowlisted", async () => {
    await expect(
      resolveCliBackendAuthForwarding({
        policy: { ...policy, credentialKinds: ["api_key"] },
        context,
        resolver: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "credential-kind-denied",
      kind: "oauth",
    });
  });

  it("distinguishes a missing resolver from an explicit decline", async () => {
    await expect(
      resolveCliBackendAuthForwarding({ policy, context }),
    ).resolves.toEqual({ status: "resolver-missing" });

    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context,
        resolver: () => null,
      }),
    ).resolves.toEqual({ status: "resolver-declined" });
  });

  it("forwards only a resolver-owned minimal envelope", async () => {
    const forwarded = {
      kind: "oauth" as const,
      providerId: "example-provider",
      profileId: "example-provider:user@example.com",
      userDataDir: "/tmp/example-profile",
    };

    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context,
        resolver: () => forwarded,
      }),
    ).resolves.toEqual({ status: "forward", credential: forwarded });
  });

  it("rejects provider, profile, or kind substitution by the resolver", async () => {
    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context,
        resolver: () => ({
          kind: "oauth",
          providerId: "other-provider",
          profileId: context.profileId,
        }),
      }),
    ).rejects.toThrow("returned provider other-provider");

    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context,
        resolver: () => ({
          kind: "oauth",
          providerId: context.provider,
          profileId: "other-profile",
        }),
      }),
    ).rejects.toThrow("returned profile other-profile");

    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context,
        resolver: () => ({
          kind: "token",
          providerId: context.provider,
          profileId: context.profileId,
        }),
      }),
    ).rejects.toThrow("returned kind token");
  });
});
