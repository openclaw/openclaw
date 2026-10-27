import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

type Options = Partial<Parameters<typeof createReplyRestartRecoveryClaimController>[0]>;
type Scope = { agentId: string; sessionKey: string; storePath: string };

export async function createRecoveryControllerFixture(
  scope: Scope,
  initial: InternalSessionEntry,
  defaults: Options = {},
  initialize = replaceSessionEntry,
) {
  let entry = initial;
  await initialize(scope, entry);
  const getSessionId = defaults.getSessionId ?? (() => entry.sessionId);
  let actor: ReturnType<typeof createReplyRecoveryActorFixture> | undefined;
  const getActor = (operation?: ReplyOperation) =>
    (actor ??= createReplyRecoveryActorFixture({
      ...scope,
      getSessionId: operation ? () => operation.sessionId : getSessionId,
      operation,
    }));
  return {
    scope,
    get entry() {
      return entry;
    },
    setEntry(next: InternalSessionEntry) {
      entry = next;
    },
    bind: () => getActor().bind(),
    acquireSessionActor: () => getActor().acquireSessionActor(),
    release: () => getActor().release(),
    controller(options: Options = {}, operation?: ReplyOperation) {
      return createReplyRestartRecoveryClaimController({
        ...scope,
        getSessionId,
        getEntry: () => entry,
        setEntry: (next) => {
          entry = next;
        },
        acquireSessionActor: () => getActor(operation).acquireSessionActor(),
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        isRestartAbort: () => false,
        resolveDeliveryContext: () => undefined,
        ...defaults,
        ...options,
      });
    },
    async [Symbol.asyncDispose]() {
      await actor?.[Symbol.asyncDispose]();
    },
  };
}
