import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export const RETAINED_DESKTOP_SESSION_KEY = "agent:main:retained-desktop-slot";

export const retainedDesktopEnvironment = {
  id: "worker-desktop-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "crabbox",
    state: "attached",
    ageMs: 1_000,
    attachedSessionIds: [RETAINED_DESKTOP_SESSION_KEY],
    tunnelStatus: "connected",
    desktopApps: [],
  },
};

export function retainedDesktopScenario(
  base: ControlUiMockGatewayScenario,
): ControlUiMockGatewayScenario {
  return {
    ...base,
    sessionKey: RETAINED_DESKTOP_SESSION_KEY,
    methodResponses: {
      ...base.methodResponses,
      "sessions.list": {
        count: 1,
        defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
        path: "",
        sessions: [
          {
            key: RETAINED_DESKTOP_SESSION_KEY,
            sessionId: RETAINED_DESKTOP_SESSION_KEY,
            kind: "direct",
            label: "Retained desktop",
            placement: { state: "active", environmentId: retainedDesktopEnvironment.id },
            updatedAt: Date.now(),
          },
        ],
        ts: Date.now(),
      },
      "environments.list": {
        environments: [retainedDesktopEnvironment],
      },
      "environments.status": retainedDesktopEnvironment,
      "desktop.observe": {
        cases: [false, true].map((control) => ({
          match: { control },
          response: {
            transport: "rfb",
            wsPath: "/desktop/observe?token=retained",
            expiresAtMs: 60_000,
            control,
          },
        })),
      },
    },
  };
}
