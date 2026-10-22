import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureReplyOperationSessionReader } from "../../sessions/session-controller.session-reader.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

export async function getRawExecuteAgentTurnForTest() {
  const execute = (await import("./agent-runner-execution.js")).executeAgentTurn;
  return async (...args: Parameters<typeof execute>) => {
    const [params] = args;
    setRuntimeConfigSnapshot(params.followupRun.run.config);
    const sessionKey = params.sessionKey ?? params.followupRun.run.sessionKey;
    if (params.replyOperation || !sessionKey) {
      return await execute(...args);
    }
    return await withSessionTurn(
      {
        sessionKey,
        sessionId: params.followupRun.run.sessionId,
        storePath: params.storePath,
        agentId: params.followupRun.run.agentId,
      },
      async (replyOperation) => {
        if (!replyOperation) {
          return await execute(...args);
        }
        const { run } = params.followupRun;
        await using actor = createReplyRecoveryActorFixture({
          operation: replyOperation,
          agentId: run.agentId,
          sessionKey,
          storePath:
            params.storePath ??
            resolveSessionStorePathCore(run.config.session?.store, { agentId: run.agentId }),
          getSessionId: () => run.sessionId,
        });
        // Production admits the physical store before capturing its tool-authority source.
        await actor.bind();
        await replyOperation.bindToolAuthoritySnapshotAsync(
          prepareReplyToolAuthority(
            params.followupRun,
            undefined,
            captureReplyOperationSessionReader(replyOperation),
          ),
        );
        return await execute({ ...params, replyOperation });
      },
    );
  };
}
