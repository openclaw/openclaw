import { AcpGatewayStore } from "../../acp/store/store.js";
import type {
  AcpGatewayRunDeliveryTargetRecord,
  AcpGatewayTerminal,
} from "../../acp/store/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { sleep } from "../../utils.js";
import type { ReplyPayload } from "../types.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import type { AcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";

const DEFAULT_PROJECTION_POLL_MS = 50;
const DEFAULT_PROJECTION_RETRY_MS = 100;

type AcpProjectionCoordinatorFactory = (params: {
  target: AcpGatewayRunDeliveryTargetRecord;
  restartMode: boolean;
}) => AcpDispatchDeliveryCoordinator;

function createTerminalErrorPayload(terminal: AcpGatewayTerminal): ReplyPayload {
  const code = terminal.errorCode?.trim() || "ACP_TURN_FAILED";
  const message = terminal.errorMessage ?? "ACP turn failed before completion.";
  return {
    text: `ACP error (${code}): ${message}\nnext: Retry, or use \`/acp cancel\` and send the message again.`,
    isError: true,
  };
}

class AcpDurableProjectionRunner {
  private readonly settledPromise: Promise<void>;
  private settledResolve!: () => void;
  private settledReject!: (error: unknown) => void;
  private stopped = false;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      store: AcpGatewayStore;
      target: AcpGatewayRunDeliveryTargetRecord;
      shouldSendToolSummaries: boolean;
      restartMode: boolean;
      coordinatorFactory: AcpProjectionCoordinatorFactory;
      pollIntervalMs?: number;
      retryDelayMs?: number;
      waitForRunStart?: boolean;
    },
  ) {
    this.settledPromise = new Promise<void>((resolve, reject) => {
      this.settledResolve = resolve;
      this.settledReject = reject;
    });
  }

  start(): Promise<void> {
    void this.run();
    return this.settledPromise;
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped) {
        try {
          const completed = await this.projectUntilCaughtUp();
          if (completed || this.stopped) {
            this.settledResolve();
            return;
          }
        } catch (error) {
          logVerbose(
            `dispatch-acp-replay: projection retry for ${this.params.target.targetKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await sleep(this.params.retryDelayMs ?? DEFAULT_PROJECTION_RETRY_MS);
        }
      }
      this.settledResolve();
    } catch (error) {
      this.settledReject(error);
    }
  }

  private async projectUntilCaughtUp(): Promise<boolean> {
    const initialState = await this.params.store.getProjectionState({
      runId: this.params.target.runId,
      targetId: this.params.target.targetId,
    });
    if (!initialState.target) {
      return true;
    }
    if (!initialState.run) {
      if (this.params.waitForRunStart) {
        await sleep(this.params.pollIntervalMs ?? DEFAULT_PROJECTION_POLL_MS);
        return false;
      }
      return true;
    }

    const target = initialState.target;
    const coordinator = this.params.coordinatorFactory({
      target,
      restartMode: this.params.restartMode,
    });
    let deliveredEffectCount = 0;
    let skipRemaining = initialState.checkpoint?.deliveredEffectCount ?? 0;
    let nextSeq = 1;
    let currentCursorSeq = 0;
    let terminalProjected = false;
    let lastKnownTerminalId = initialState.run.terminal?.terminalEventId;

    const projector = createAcpReplyProjector({
      cfg: this.params.cfg,
      shouldSendToolSummaries: this.params.shouldSendToolSummaries,
      provider: target.provider,
      accountId: target.accountId,
      deliver: async (kind, payload, meta) => {
        currentCursorSeq = Math.max(currentCursorSeq, nextSeq - 1);
        deliveredEffectCount += 1;
        if (skipRemaining > 0) {
          skipRemaining -= 1;
          return true;
        }
        const delivered = await coordinator.deliver(kind, payload, meta);
        if (!delivered) {
          throw new Error(`ACP durable delivery failed for ${kind}.`);
        }
        await this.params.store.recordProjectorCheckpoint({
          sessionKey: target.sessionKey,
          runId: target.runId,
          targetId: target.targetId,
          cursorSeq: currentCursorSeq,
          deliveredEffectCount,
        });
        return true;
      },
    });

    const replayState = async () => {
      const state = await this.params.store.getProjectionState({
        runId: target.runId,
        targetId: target.targetId,
      });
      if (!state.target || !state.run) {
        return { state, completed: true };
      }
      for (const event of state.events) {
        if (event.seq < nextSeq) {
          continue;
        }
        currentCursorSeq = event.seq;
        nextSeq = event.seq + 1;
        await projector.onEvent(event.event);
      }
      if (state.run.terminal && !terminalProjected) {
        currentCursorSeq = state.run.highestAcceptedSeq;
        if (state.run.terminal.kind === "failed") {
          await projector.onEvent({
            type: "error",
            message: state.run.terminal.errorMessage ?? "ACP turn failed before completion.",
            ...(state.run.terminal.errorCode ? { code: state.run.terminal.errorCode } : {}),
          });
          await this.deliverFailedTerminal({
            target: state.target,
            coordinator,
            terminal: state.run.terminal,
            deliveredEffectCountRef: () => deliveredEffectCount,
            incrementDeliveredEffectCount: () => {
              deliveredEffectCount += 1;
            },
            skipRemainingRef: () => skipRemaining,
            decrementSkipRemaining: () => {
              skipRemaining -= 1;
            },
            cursorSeq: currentCursorSeq,
          });
        } else {
          await projector.onEvent({
            type: "done",
            ...(state.run.terminal.stopReason ? { stopReason: state.run.terminal.stopReason } : {}),
          });
        }
        await this.deliverSyntheticFinalTts({
          coordinator,
          deliveredEffectCountRef: () => deliveredEffectCount,
          incrementDeliveredEffectCount: () => {
            deliveredEffectCount += 1;
          },
          skipRemainingRef: () => skipRemaining,
          decrementSkipRemaining: () => {
            skipRemaining -= 1;
          },
          cursorSeq: currentCursorSeq,
        });
        terminalProjected = true;
        lastKnownTerminalId = state.run.terminal.terminalEventId;
      }
      return { state, completed: terminalProjected };
    };

    const initialReplay = await replayState();
    if (initialReplay.completed) {
      return true;
    }

    while (!this.stopped) {
      await sleep(this.params.pollIntervalMs ?? DEFAULT_PROJECTION_POLL_MS);
      const step = await replayState();
      if (step.completed) {
        return true;
      }
      const terminalId = step.state.run?.terminal?.terminalEventId;
      if (terminalId && terminalId === lastKnownTerminalId) {
        continue;
      }
      lastKnownTerminalId = terminalId;
    }

    return true;
  }

  private async deliverFailedTerminal(params: {
    target: AcpGatewayRunDeliveryTargetRecord;
    coordinator: AcpDispatchDeliveryCoordinator;
    terminal: AcpGatewayTerminal;
    deliveredEffectCountRef: () => number;
    incrementDeliveredEffectCount: () => void;
    skipRemainingRef: () => number;
    decrementSkipRemaining: () => void;
    cursorSeq: number;
  }): Promise<void> {
    params.incrementDeliveredEffectCount();
    if (params.skipRemainingRef() > 0) {
      params.decrementSkipRemaining();
      return;
    }
    const delivered = await params.coordinator.deliver(
      "final",
      createTerminalErrorPayload(params.terminal),
    );
    if (!delivered) {
      throw new Error("ACP durable failed-terminal delivery failed.");
    }
    await this.params.store.recordProjectorCheckpoint({
      sessionKey: params.target.sessionKey,
      runId: params.target.runId,
      targetId: params.target.targetId,
      cursorSeq: params.cursorSeq,
      deliveredEffectCount: params.deliveredEffectCountRef(),
    });
  }

  private async deliverSyntheticFinalTts(params: {
    coordinator: AcpDispatchDeliveryCoordinator;
    deliveredEffectCountRef: () => number;
    incrementDeliveredEffectCount: () => void;
    skipRemainingRef: () => number;
    decrementSkipRemaining: () => void;
    cursorSeq: number;
  }): Promise<void> {
    const nextEffectCount = params.deliveredEffectCountRef() + 1;
    const checkpoint = await this.params.store.getCheckpoint(
      `projector:${this.params.target.runId}:${this.params.target.targetId}`,
    );
    if (
      checkpoint?.pendingSyntheticFinalEffectCount === nextEffectCount &&
      checkpoint.pendingSyntheticFinalCursorSeq === params.cursorSeq
    ) {
      params.incrementDeliveredEffectCount();
      await this.recordSettledSyntheticFinalCheckpoint({
        cursorSeq: params.cursorSeq,
        deliveredEffectCount: params.deliveredEffectCountRef(),
      });
      return;
    }

    if (
      params.coordinator.hasDeliveredSyntheticFinal({
        cursorSeq: params.cursorSeq,
        effectCount: nextEffectCount,
      })
    ) {
      params.incrementDeliveredEffectCount();
      await this.recordSettledSyntheticFinalCheckpoint({
        cursorSeq: params.cursorSeq,
        deliveredEffectCount: params.deliveredEffectCountRef(),
      });
      return;
    }

    const syntheticFinalPayload = await params.coordinator.resolveSyntheticFinalPayload();
    if (!syntheticFinalPayload) {
      return;
    }
    params.incrementDeliveredEffectCount();
    if (params.skipRemainingRef() > 0) {
      params.decrementSkipRemaining();
      return;
    }
    const delivered = await params.coordinator.deliver("final", syntheticFinalPayload);
    if (!delivered) {
      throw new Error("ACP durable final-TTS delivery failed.");
    }
    params.coordinator.markSyntheticFinalDelivered({
      cursorSeq: params.cursorSeq,
      effectCount: params.deliveredEffectCountRef(),
    });
    await this.recordSettledSyntheticFinalCheckpoint({
      cursorSeq: params.cursorSeq,
      deliveredEffectCount: params.deliveredEffectCountRef(),
    });
  }

  private async recordSettledSyntheticFinalCheckpoint(params: {
    cursorSeq: number;
    deliveredEffectCount: number;
  }): Promise<void> {
    try {
      await this.params.store.recordProjectorCheckpoint({
        sessionKey: this.params.target.sessionKey,
        runId: this.params.target.runId,
        targetId: this.params.target.targetId,
        cursorSeq: params.cursorSeq,
        deliveredEffectCount: params.deliveredEffectCount,
      });
      return;
    } catch (checkpointError) {
      try {
        await this.params.store.recordProjectorPendingSyntheticFinal({
          sessionKey: this.params.target.sessionKey,
          runId: this.params.target.runId,
          targetId: this.params.target.targetId,
          cursorSeq: params.cursorSeq,
          deliveredEffectCount: params.deliveredEffectCount,
        });
      } catch {
        await this.params.store.recordProjectorCheckpoint({
          sessionKey: this.params.target.sessionKey,
          runId: this.params.target.runId,
          targetId: this.params.target.targetId,
          cursorSeq: params.cursorSeq,
          deliveredEffectCount: params.deliveredEffectCount,
        });
        return;
      }
      throw checkpointError;
    }
  }
}

export class AcpDurableProjectionService {
  private readonly activeByTargetKey = new Map<string, AcpDurableProjectionRunner>();

  constructor(
    private readonly params: {
      store: AcpGatewayStore;
      coordinatorFactory: AcpProjectionCoordinatorFactory;
    },
  ) {}

  ensureProjection(params: {
    cfg: OpenClawConfig;
    target: AcpGatewayRunDeliveryTargetRecord;
    shouldSendToolSummaries: boolean;
    restartMode: boolean;
    pollIntervalMs?: number;
    retryDelayMs?: number;
    waitForRunStart?: boolean;
  }): Promise<void> {
    const existing = this.activeByTargetKey.get(params.target.targetKey);
    if (existing) {
      return existing.start();
    }
    const runner = new AcpDurableProjectionRunner({
      cfg: params.cfg,
      store: this.params.store,
      target: params.target,
      shouldSendToolSummaries: params.shouldSendToolSummaries,
      restartMode: params.restartMode,
      coordinatorFactory: this.params.coordinatorFactory,
      pollIntervalMs: params.pollIntervalMs,
      retryDelayMs: params.retryDelayMs,
      waitForRunStart: params.waitForRunStart,
    });
    this.activeByTargetKey.set(params.target.targetKey, runner);
    const settled = runner.start();
    void settled.finally(() => {
      if (this.activeByTargetKey.get(params.target.targetKey) === runner) {
        this.activeByTargetKey.delete(params.target.targetKey);
      }
    });
    return settled;
  }

  async resumeAll(params: {
    cfg: OpenClawConfig;
    shouldSendToolSummaries: boolean;
  }): Promise<{ started: string[] }> {
    const started: string[] = [];
    for (const target of await this.params.store.listDeliveryTargets()) {
      started.push(target.targetKey);
      void this.ensureProjection({
        cfg: params.cfg,
        target,
        shouldSendToolSummaries: params.shouldSendToolSummaries,
        restartMode: true,
        waitForRunStart: false,
      });
    }
    return { started };
  }

  stopAll(): void {
    for (const runner of this.activeByTargetKey.values()) {
      runner.stop();
    }
    this.activeByTargetKey.clear();
  }
}

let acpDurableProjectionServiceSingleton: AcpDurableProjectionService | null = null;

export function getAcpDurableProjectionService(params: {
  store: AcpGatewayStore;
  coordinatorFactory: AcpProjectionCoordinatorFactory;
}): AcpDurableProjectionService {
  if (!acpDurableProjectionServiceSingleton) {
    acpDurableProjectionServiceSingleton = new AcpDurableProjectionService(params);
  }
  return acpDurableProjectionServiceSingleton;
}

export const __testing = {
  resetAcpDurableProjectionServiceForTests() {
    acpDurableProjectionServiceSingleton?.stopAll();
    acpDurableProjectionServiceSingleton = null;
  },
};
