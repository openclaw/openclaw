import type { HelloOk } from "@openclaw/gateway-protocol";

export type ControlUiMockAuth = {
  deviceToken?: string | null;
  authMethod?: HelloOk["auth"]["method"];
  authMode?: HelloOk["snapshot"]["authMode"] | null;
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
  };
}
