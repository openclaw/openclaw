import { expect, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { countActiveRunsForSession } from "../registry/subagent-registry.js";
import type { spawnSubagentDirect } from "./subagent-spawn.js";

export async function expectSharedPendingSpawnCapacity(params: {
  config: OpenClawConfig;
  spawn: typeof spawnSubagentDirect;
  callGatewayMock: Pick<Mock, "mockImplementation">;
  countActiveRuns: typeof countActiveRunsForSession;
  signal: AbortSignal;
}) {
  const { maybeSpawnVisibleSession } = await import("../../tools/sessions-spawn-visible.js");
  const nativeDispatchStarted = createDeferred();
  const releaseNativeDispatch = createDeferred();
  params.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
    if (request.method === "agent") {
      nativeDispatchStarted.resolve();
      await releaseNativeDispatch.promise;
      return { runId: "native-run" };
    }
    return request.method?.startsWith("sessions.") ? { ok: true } : {};
  });
  const controllerSessionKey = "agent:main:telegram:default:direct:456";
  const native = params.spawn(
    { task: "pending native child" },
    { agentSessionKey: controllerSessionKey, completionOwnerKey: "agent:main:main" },
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        nativeDispatchStarted.promise,
        native,
        "Native spawn settled before reaching its Gateway dispatch",
      ),
      params.signal,
    );
    const visibleGateway = vi.fn();
    const rejected = await withinTest(
      maybeSpawnVisibleSession({
        raw: { visible: true },
        task: "visible over-cap child",
        label: "",
        runtime: "subagent",
        sandbox: "inherit",
        expectsCompletionMessage: true,
        options: {
          agentSessionKey: controllerSessionKey,
          completionOwnerKey: "agent:main:main",
          config: params.config,
          callGateway: visibleGateway,
          countActiveRuns: params.countActiveRuns,
        },
      }),
      params.signal,
    );
    expect(rejected).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("max active children for this session (1/1"),
    });
    expect(visibleGateway).not.toHaveBeenCalled();
  } finally {
    releaseNativeDispatch.resolve();
    await native;
  }
  expect(await native).toMatchObject({ status: "accepted", runId: "native-run" });
}
