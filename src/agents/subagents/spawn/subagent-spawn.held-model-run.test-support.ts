import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import {
  recordSpawnBoundaryFinal,
  type createSpawnBoundaryParent,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function createHeldModelRun(
  runEmbeddedAgent: NativePluginSpawnTestOptions["runEmbeddedAgent"],
) {
  return function holdModelRun(
    bound: Pick<Awaited<ReturnType<typeof createSpawnBoundaryParent>>, "storePath">,
    text: string,
    onStart?: (params: Parameters<typeof runEmbeddedAgent>[0]) => Promise<void>,
  ) {
    const result = createDeferred<EmbeddedAgentRunResult>();
    const started = createDeferred();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      try {
        if (onStart) {
          await onStart(params);
        }
      } catch (error) {
        started.reject(error);
        throw error;
      }
      started.resolve();
      const reply = await result.promise;
      await recordSpawnBoundaryFinal({
        storePath: bound.storePath,
        sessionKey: expectDefined(params.sessionKey, "child session"),
        runId: params.runId,
        text,
      });
      return reply;
    });
    return { started: started.promise, finish: () => result.resolve(visibleResult(text)) };
  };
}
