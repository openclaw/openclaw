import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  GatewayAuthorizationRuntime,
  GatewayMethodAccessPolicy,
  GatewayRbacDenialReason,
  GatewayResourceRef,
  GatewayResourceResolutionInput,
} from "./contracts.js";
import { authorizeGatewayAccess } from "./kernel.js";

const config = {} as OpenClawConfig;
const principal = {
  issuer: "trusted-proxy",
  subject: "member@example.com",
  kind: "human",
} as const;
const resource: GatewayResourceRef = {
  namespace: "core",
  type: "session",
  id: "session-1",
};

function resourcePolicy(
  resolveResources: (
    input: GatewayResourceResolutionInput,
  ) => readonly GatewayResourceRef[] | Promise<readonly GatewayResourceRef[]>,
): GatewayMethodAccessPolicy {
  return {
    kind: "resource",
    permission: "session.read",
    resolveResources,
  };
}

describe("gateway authorization kernel", () => {
  it("preserves legacy behavior without resolving resources or calling a provider", async () => {
    const resolveResources = vi.fn(() => [resource]);
    const authorize = vi.fn(async () => ({ allowed: false, reason: "forbidden" }) as const);

    const result = await authorizeGatewayAccess({
      runtime: { mode: "legacy" },
      policy: resourcePolicy(resolveResources),
      principal,
      method: "sessions.get",
      params: { key: "session-1" },
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: true });
    expect(resolveResources).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("allows an explicitly public method in isolated mode without a principal", async () => {
    const authorize = vi.fn();

    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize },
      policy: { kind: "public" },
      method: "health",
      params: undefined,
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: true });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown runtime mode even for an explicitly public method", async () => {
    const result = await authorizeGatewayAccess({
      runtime: { mode: "corrupt" } as unknown as GatewayAuthorizationRuntime,
      policy: { kind: "public" },
      method: "health",
      params: undefined,
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "indeterminate" });
  });

  it("denies an unclassified method in isolated mode", async () => {
    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize: vi.fn() },
      method: "sessions.get",
      params: {},
      getConfig: () => config,
      principal,
    });

    expect(result).toEqual({ allowed: false, reason: "unclassified-method" });
  });

  it("denies a resource method without a server-issued principal", async () => {
    const resolveResources = vi.fn(() => [resource]);

    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize: vi.fn() },
      policy: resourcePolicy(resolveResources),
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "unauthenticated" });
    expect(resolveResources).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no resources", resources: [] },
    { label: "blank namespace", resources: [{ ...resource, namespace: " " }] },
    { label: "blank type", resources: [{ ...resource, type: "" }] },
    { label: "blank id", resources: [{ ...resource, id: "  " }] },
  ])("fails closed when a resolver returns $label", async ({ resources }) => {
    const authorize = vi.fn();

    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize },
      policy: resourcePolicy(() => resources),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "unbound-resource" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("fails closed when resource resolution throws", async () => {
    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize: vi.fn() },
      policy: resourcePolicy(() => {
        throw new Error("resolver failed");
      }),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "indeterminate" });
  });

  it("fails closed when a resolver returns non-string resource fields", async () => {
    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize: vi.fn() },
      policy: resourcePolicy(
        () => [{ ...resource, namespace: 42 }] as unknown as readonly GatewayResourceRef[],
      ),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "unbound-resource" });
  });

  it("returns the stable principal and isolation domain from an allowed provider decision", async () => {
    const authorize = vi.fn(async () => ({
      allowed: true as const,
      principalId: "principal-1",
      domain: { id: "domain-1" },
    }));

    const result = await authorizeGatewayAccess({
      runtime: { mode: "isolated", authorize },
      policy: resourcePolicy(() => [resource]),
      principal,
      method: "sessions.get",
      params: { key: "session-1" },
      getConfig: () => config,
    });

    expect(authorize).toHaveBeenCalledWith({
      principal,
      method: "sessions.get",
      permission: "session.read",
      resources: [resource],
    });
    expect(result).toEqual({
      allowed: true,
      security: { principalId: "principal-1", domain: { id: "domain-1" } },
    });
  });

  it.each([
    { principalId: "", domain: { id: "domain-1" } },
    { principalId: "principal-1", domain: { id: " " } },
  ])("fails closed on a malformed allowed provider decision", async (decision) => {
    const result = await authorizeGatewayAccess({
      runtime: {
        mode: "isolated",
        authorize: async () => ({ allowed: true, ...decision }),
      },
      policy: resourcePolicy(() => [resource]),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "indeterminate" });
  });

  it.each<GatewayRbacDenialReason>([
    "unknown-principal",
    "unbound-resource",
    "cross-domain",
    "forbidden",
    "indeterminate",
  ])("retains the provider denial reason %s", async (reason) => {
    const runtime: GatewayAuthorizationRuntime = {
      mode: "isolated",
      authorize: async () => ({ allowed: false, reason }),
    };

    const result = await authorizeGatewayAccess({
      runtime,
      policy: resourcePolicy(() => [resource]),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason });
  });

  it("fails closed when the provider throws", async () => {
    const result = await authorizeGatewayAccess({
      runtime: {
        mode: "isolated",
        authorize: async () => {
          throw new Error("provider failed");
        },
      },
      policy: resourcePolicy(() => [resource]),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "indeterminate" });
  });

  it("fails closed when the provider returns an unknown denial reason", async () => {
    const result = await authorizeGatewayAccess({
      runtime: {
        mode: "isolated",
        authorize: async () =>
          ({ allowed: false, reason: "unexpected" }) as unknown as Awaited<
            ReturnType<Extract<GatewayAuthorizationRuntime, { mode: "isolated" }>["authorize"]>
          >,
      },
      policy: resourcePolicy(() => [resource]),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "indeterminate" });
  });

  it("fails closed when the provider returns a non-boolean allowed discriminant", async () => {
    const result = await authorizeGatewayAccess({
      runtime: {
        mode: "isolated",
        authorize: async () =>
          ({
            allowed: "false",
            principalId: "principal-1",
            domain: { id: "domain-1" },
          }) as unknown as Awaited<
            ReturnType<Extract<GatewayAuthorizationRuntime, { mode: "isolated" }>["authorize"]>
          >,
      },
      policy: resourcePolicy(() => [resource]),
      principal,
      method: "sessions.get",
      params: {},
      getConfig: () => config,
    });

    expect(result).toEqual({ allowed: false, reason: "indeterminate" });
  });
});
