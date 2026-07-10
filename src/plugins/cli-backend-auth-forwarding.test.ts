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
    profileId: "example-provider:user@example.com",
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

  it("rejects mismatched input identity before invoking the resolver", async () => {
    const providerResolver = vi.fn();
    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context: {
          ...context,
          credential: { ...context.credential, provider: "other-provider" },
        },
        resolver: providerResolver,
      }),
    ).resolves.toEqual({
      status: "credential-provider-mismatch",
      selectedProvider: "example-provider",
      credentialProvider: "other-provider",
    });
    expect(providerResolver).not.toHaveBeenCalled();

    const profileResolver = vi.fn();
    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context: {
          ...context,
          credential: { ...context.credential, profileId: "other-profile" },
        },
        resolver: profileResolver,
      }),
    ).resolves.toEqual({
      status: "credential-profile-mismatch",
      selectedProfileId: "example-provider:user@example.com",
      credentialProfileId: "other-profile",
    });
    expect(profileResolver).not.toHaveBeenCalled();
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

  it("fails closed when the credential kind is not allowlisted", async () => {
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
    await expect(resolveCliBackendAuthForwarding({ policy, context })).resolves.toEqual({
      status: "resolver-missing",
    });

    await expect(
      resolveCliBackendAuthForwarding({
        policy,
        context,
        resolver: () => null,
      }),
    ).resolves.toEqual({ status: "resolver-declined" });
  });

  it("forwards only a resolver-owned closed execution envelope", async () => {
    const forwarded = {
      kind: "oauth" as const,
      providerId: "example-provider",
      profileId: "example-provider:user@example.com",
      env: { EXAMPLE_CLI_TOKEN_FILE: "/tmp/example-profile/token.json" },
      clearEnv: ["EXAMPLE_API_KEY"],
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
