import { afterEach, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { prepareWorkerGitHubExecutionGrant } from "./worker-github-execution-identity.js";

const session = { agentId: "main", sessionId: "session-1", sessionKey: "agent:main:worker" };
const workerPlacement = {
  runId: "worker-run",
  nodeId: "worker-node",
  workspace: {
    workspaceDir: "/synthetic/workspace",
    environmentId: "worker-environment",
    ownerEpoch: 7,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
  },
};

afterEach(clearRuntimeConfigSnapshot);

it("refuses a Codex App grant without the exact dedicated worker admission", async () => {
  setRuntimeConfigSnapshot({});
  const prepare = () =>
    prepareWorkerGitHubExecutionGrant({
      ...session,
      expectedProfileId: "synthetic-app",
      workerPlacement,
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: "synthetic-operator",
        scopes: ["operator.write"],
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    });
  await expect(prepare()).rejects.toThrow("exact worker placement");
  await expect(
    withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        assertNodeExecutionCurrent: (request) => {
          expect(request).toEqual({
            ...workerPlacement,
            agentId: session.agentId,
            requireDedicatedWorker: true,
          });
          throw new Error("Placement admission refused");
        },
      },
      prepare,
    ),
  ).rejects.toThrow("Placement admission refused");
});
