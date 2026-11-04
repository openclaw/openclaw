import type { CronStoredJob } from "./types.js";

export function createTestCronOperatorSource(ownerSessionKey: string) {
  return {
    executionRevision: "exec-1",
    source: {
      version: 1,
      agentId: "main",
      sessionKey: ownerSessionKey,
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      sourceRunId: "source-run",
      snapshot: {
        profileId: "profile-1",
        scopes: ["operator.admin"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "grant-gen",
          role: "operator",
          authMethod: "device-token",
        },
        device: { deviceId: "device-1", key: "a".repeat(64) },
        controlUiAdmin: true,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    },
  } as unknown as NonNullable<CronStoredJob["operatorSource"]>;
}
