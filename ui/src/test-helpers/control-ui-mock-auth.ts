import type { HelloOk } from "@openclaw/gateway-protocol";

export type ControlUiMockAuth = {
  deviceToken?: string | null;
  authMethod?: HelloOk["auth"]["method"];
  authMode?: HelloOk["snapshot"]["authMode"] | null;
  /** Operator scopes returned by the mocked connect handshake. */
  operatorScopes?: string[];
  /** Handshake presentation fact from the authenticated role ceiling, not device scopes. */
  roleAllowsAdmin?: boolean;
  /** Role-limited access to other people's sessions, as reported by the Gateway. */
  operatorSessionCap?: HelloOk["auth"]["sessionCap"] | null;
  /** Canonical current-role person-timeline restriction from the authenticated hello. */
  profileActivityViewerId?: string | null;
  /** Simulate a legacy Gateway whose connect hello predates the auth projection. */
  omitConnectHelloAuth?: boolean;
};

export function normalizeControlUiMockAuth(scenario: ControlUiMockAuth) {
  return {
    // Prepared scenarios are normalized again before serialization; preserve explicit omission.
    deviceToken:
      scenario.deviceToken === null ? null : scenario.deviceToken?.trim() || "e2e-device-token",
    authMethod: scenario.authMethod ?? "token",
    authMode: scenario.authMode ?? null,
    omitConnectHelloAuth: scenario.omitConnectHelloAuth ?? false,
    operatorSessionCap: scenario.operatorSessionCap ?? null,
    profileActivityViewerId: scenario.profileActivityViewerId,
    roleAllowsAdmin: scenario.roleAllowsAdmin ?? true,
    // Role presentation is fixed for this hello; socket scopes remain independently mutable.
    operatorRolePolicy: {
      roleAllowsAdmin: scenario.roleAllowsAdmin ?? true,
      ...(scenario.operatorSessionCap ? { sessionCap: scenario.operatorSessionCap } : {}),
      ...(scenario.profileActivityViewerId !== undefined
        ? { profileActivityViewerId: scenario.profileActivityViewerId }
        : {}),
    },
    operatorScopes: scenario.operatorScopes ?? [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ],
  };
}
