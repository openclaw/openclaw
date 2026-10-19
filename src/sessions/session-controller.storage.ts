import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  ReplyMessageInjectionAttempt,
  ReplyOperation,
  SessionControllerEntry,
  ReplyOperationAdmission,
  ReplyOperationAfterClear,
  ReplyOperationSuccessorBarrierGroup,
} from "./session-controller.contracts.js";
import type { RpcSourceRef } from "./session-controller.rpc-sources.types.js";
const controllerState = resolveGlobalSingleton(Symbol.for("openclaw.sessionControllers"), () => ({
  controllers: new Map<string, SessionControllerEntry>(),
  entriesByAlias: new Map<string, Set<SessionControllerEntry>>(),
  entriesByStore: new Map<string, Set<SessionControllerEntry>>(),
  protectionReleaseListeners: new Map<string, Set<() => void>>(),
  rpcSourcesByRunId: new Map<string, Set<RpcSourceRef>>(),
  rpcSourceRemovalByRef: new WeakMap<RpcSourceRef, () => void>(),
  entryByOperation: new WeakMap<ReplyOperation, SessionControllerEntry>(),
  lifecycleAdmissionByOperation: new WeakMap<ReplyOperation, ReplyOperationAdmission>(),
  evictOperationByOperation: new WeakMap<ReplyOperation, () => void>(),
  executionStartedOperations: new WeakSet<ReplyOperation>(),
  backendRunIdsByOperation: new WeakMap<ReplyOperation, Set<string>>(),
  operationsByUpstreamAbortSignal: new WeakMap<AbortSignal, ReplyOperation>(),
  producerCompletionByOperation: new WeakMap<ReplyOperation, Promise<unknown>>(),
  backendReadyByOperation: new WeakMap<ReplyOperation, Promise<void>>(),
  messageAdmissionsByAttachment: new WeakMap<object, Map<string, ReplyMessageInjectionAttempt>>(),
  afterClearByOperation: new WeakMap<ReplyOperation, ReplyOperationAfterClear>(),
  successorBarrierStartsByOperation: new WeakMap<ReplyOperation, Set<() => void>>(),
  successorBarrierGroupsByOperation: new WeakMap<
    ReplyOperation,
    Set<ReplyOperationSuccessorBarrierGroup>
  >(),
}));
export const sessionControllers = controllerState.controllers;
export const sessionControllerEntriesByAlias = controllerState.entriesByAlias;
export const sessionControllerEntriesByStore = controllerState.entriesByStore;
export const sessionControllerProtectionReleaseListeners =
  controllerState.protectionReleaseListeners;
export const rpcSourcesByRunId = controllerState.rpcSourcesByRunId;
export const rpcSourceRemovalByRef = controllerState.rpcSourceRemovalByRef;
export const controllerEntryByOperation = controllerState.entryByOperation;
export const lifecycleAdmissionByOperation = controllerState.lifecycleAdmissionByOperation;

export const evictReplyOperationByOperation = controllerState.evictOperationByOperation;
export const executionStartedOperations = controllerState.executionStartedOperations;
export const backendRunIdsByOperation = controllerState.backendRunIdsByOperation;
export const operationsByUpstreamAbortSignal = controllerState.operationsByUpstreamAbortSignal;
export const producerCompletionByOperation = controllerState.producerCompletionByOperation;
export const backendReadyByOperation = controllerState.backendReadyByOperation;
export const messageAdmissionsByAttachment = controllerState.messageAdmissionsByAttachment;
export const afterClearByOperation = controllerState.afterClearByOperation;
export const successorBarrierStartsByOperation = controllerState.successorBarrierStartsByOperation;
export const successorBarrierGroupsByOperation = controllerState.successorBarrierGroupsByOperation;

// Mailbox-only producers allocate this state without loading operation lifecycle
// runtime. Publish cleanup with the storage owner so a completed test file cannot
// retain reservations that block the next file's FIFO admission.
if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  Object.assign(globalThis, {
    [Symbol.for("openclaw.sessionControllerTestApi")]: {
      resetSessionControllerForTest(): void {
        for (const entry of controllerState.controllers.values()) {
          entry.active?.watchdog.close();
          for (const operation of entry.lifecycle?.operations ?? []) {
            operation.watchdog.close();
          }
          for (const waiter of entry.waiters) {
            waiter.finish(false);
          }
        }
        controllerState.controllers.clear();
        controllerState.entriesByAlias.clear();
        controllerState.entriesByStore.clear();
        controllerState.rpcSourcesByRunId.clear();
      },
    },
  });
}
