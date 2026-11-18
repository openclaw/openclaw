import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  withSessionRowProjectionState,
  seedProjectionRow,
  appendProjectionMessages,
} from "./session-row-projection.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

it("keeps a restored private run outside a nonmember plugin caller's view", async () => {
  await withSessionRowProjectionState(async (create, state) => {
    const cfg = rolePolicyConfig();
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const owner = roleClient("none", "run-owner");
    const other = roleClient("none", "nonmember");
    const runId = "private-completed-run";
    const profile = owner.authenticatedUserProfile;
    expect.assert(profile);
    const privateRow = seedProjectionRow("private", {
      visibility: "draft",
      createdActor: {
        type: "human",
        source: "profile",
        id: profile.profileId,
      },
      lastRunId: runId,
      status: "done",
      startedAt: 1,
      endedAt: 2,
    });
    await appendProjectionMessages(privateRow.scope, {
      role: "user",
      content: "private",
      timestamp: 1,
      idempotencyKey: runId + ":user",
    });
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => cfg;
    context.getGatewayMethodRegistry = () => createRequestGatewayMethodRegistry();
    context.trackExecution = trackAsyncWork;
    context.createAgentTurnFacade = (principal) =>
      createInternalAgentTurnFacade({ ...principal, getContext: () => context });
    const projection = await create({ cfg, modelCatalog: [], context });
    bindSessionRowProjection(context, () => projection);
    const runtime = createGatewaySubagentRuntime(() => context);
    const wait = (id: string) =>
      withPluginRuntimeGatewayRequestScope(
        { context, client: other, isWebchatConnect: () => false },
        () => runtime.waitForRun({ runId: id, timeoutMs: 0 }),
      );
    const result = await wait(runId);
    const missing = await wait("absent-run");
    expect(missing.status).toBe("timeout");
    expect(result.status).toBe(missing.status);
  });
});
