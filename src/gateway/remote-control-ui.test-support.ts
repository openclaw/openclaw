import type { RemoteControlUiIngressContext } from "./remote-control-ui-context.js";

export function createRemoteControlUiIngressTestContext(
  overrides: Partial<RemoteControlUiIngressContext> = {},
): RemoteControlUiIngressContext {
  const context: RemoteControlUiIngressContext = {
    pluginId: "remote-ui-test",
    audienceId: "test-grant",
    publicOrigin: "https://ui.example.test",
    sandboxOrigin: "https://sandbox.example.test",
    principal: { kind: "owner" },
    resolvePrincipal() {
      const profileId =
        context.principal.kind === "person" ? context.principal.profileId : "gateway-owner";
      return {
        bindingId: context.audienceId,
        authenticatedUserProfile: {
          profileId,
          displayName: "Synthetic ingress user",
          avatarRevision: "0",
          hasAvatar: false,
          updatedAt: 0,
        },
        preparedSessionProfile: {
          profileId,
          role: null,
          githubLogin: null,
          aliases: new Set([profileId]),
        },
        operatorRoleActor:
          context.principal.kind === "person"
            ? { kind: "operator", profileId }
            : { kind: "system" },
        scopes: [...context.operatorScopeCeiling],
        signal: context.signal,
        assertCurrent: context.assertCurrent,
      };
    },
    operatorScopeCeiling: ["operator.read", "operator.write"] as const,
    frameAncestors: ["https://host.example.test", "codex-sandbox:"],
    signal: new AbortController().signal,
    assertCurrent() {},
    trackWork: <T>(work: Promise<T>) => work,
    ...overrides,
  };
  return Object.freeze(context);
}
