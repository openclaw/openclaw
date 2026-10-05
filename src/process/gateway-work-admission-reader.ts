import type { GatewaySuspension } from "../../packages/gateway-protocol/src/schema/gateway-suspend.js";
import type { GatewayWorkAdmissionState } from "./gateway-work-admission.js";

export type GatewaySuspendAdmissionPhase = GatewaySuspension["phase"];

export type GatewayRootWorkAdmissionLease = {
  ownsRoot: boolean;
  release: () => void;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

export type GatewayReaderAdmissionState = {
  writerRetired: boolean;
  writerSettled: boolean;
  readerReady: boolean;
  readerLifetimeRetired: boolean;
  readerExpiresAtMs?: number;
  readerDeadlineAtMs?: number;
};

type ReaderAdmissionOwner = {
  DrainingError: new (message: string) => Error;
  getGatewaySuspendAdmissionPhase: () => GatewaySuspension["phase"];
  getActiveGatewayRootWorkCount: (opts?: { excludeReadonly?: boolean }) => number;
  markGatewayRestartDraining: (reason: "restart") => void;
  isGatewayRestartDraining: () => boolean;
  createGatewayRootWorkAdmission: (
    origin: string,
    detached?: boolean,
    readonly?: boolean,
    cleanup?: boolean,
  ) => GatewayRootWorkAdmissionLease;
};

/** Native retirement uses the process admission owner's existing state and roots. */
export function createGatewayReaderAdmission(
  state: GatewayWorkAdmissionState,
  owner: ReaderAdmissionOwner,
) {
  const {
    getGatewaySuspendAdmissionPhase,
    getActiveGatewayRootWorkCount,
    markGatewayRestartDraining,
    isGatewayRestartDraining,
    createGatewayRootWorkAdmission,
  } = owner;
  /** Retirement fences execution permanently before native background joins begin. */
  function retireGatewayWriterAdmission(expiresAtMs: number, deadlineAtMs: number): void {
    if (state.writerRetired) {
      return;
    }
    if (
      getGatewaySuspendAdmissionPhase() !== "prepared" ||
      getActiveGatewayRootWorkCount({ excludeReadonly: true }) !== 0
    ) {
      throw new owner.DrainingError(
        "Writer retirement requires an exact prepared zero-work suspension",
      );
    }
    state.writerRetired = true;
    state.readerExpiresAtMs = expiresAtMs;
    state.readerDeadlineAtMs = deadlineAtMs;
    markGatewayRestartDraining("restart");
  }

  /** The lifecycle owner publishes read authority only after every writer has joined. */
  function publishGatewayReaderAdmission(expiresAtMs: number, deadlineAtMs: number): void {
    if (
      !state.writerRetired ||
      state.readerLifetimeRetired ||
      state.writerSettled ||
      Date.now() >= expiresAtMs ||
      performance.now() >= deadlineAtMs
    ) {
      throw new owner.DrainingError("Native writer retirement is not committed");
    }
    if (getActiveGatewayRootWorkCount({ excludeReadonly: true }) !== 0) {
      throw new owner.DrainingError("Native retirement still owns unsettled writer roots");
    }
    state.readerReady = true;
    state.writerSettled = true;
    state.readerExpiresAtMs = expiresAtMs;
    state.readerDeadlineAtMs = deadlineAtMs;
  }

  /** Only the native close owner retains this bounded cleanup root after foreground retirement. */
  async function runWithGatewayWriterRetirementCleanup<T>(close: () => Promise<T>): Promise<T> {
    if (!state.writerRetired || state.writerSettled) {
      throw new owner.DrainingError("Native writer cleanup custody is unavailable");
    }
    const cleanup = createGatewayRootWorkAdmission("gateway:writer-retirement", false, false, true);
    try {
      return await cleanup.run(close);
    } finally {
      cleanup.release();
    }
  }

  function isGatewayReaderReady(): boolean {
    if (
      state.readerReady &&
      (Date.now() >= state.readerExpiresAtMs! || performance.now() >= state.readerDeadlineAtMs!)
    ) {
      retireGatewayReaderAdmission();
    }
    return state.readerReady;
  }

  function isGatewayWriterRetired(): boolean {
    return state.writerRetired;
  }

  function isGatewayReadonlyWork(): boolean {
    return state.writerRetired || state.currentRootWork.getStore()?.readonlyOnly === true;
  }

  function assertGatewaySqliteWriterAdmission(): void {
    const current = state.currentRootWork.getStore();
    if (
      state.writerSettled ||
      current?.readonlyOnly ||
      (state.writerRetired && (!current?.retirementCleanup || current.released))
    ) {
      throw new owner.DrainingError(
        "Read-only Gateway work cannot acquire SQLite writer authority",
      );
    }
  }

  function retireGatewayReaderAdmission(): void {
    state.readerReady = false;
    state.readerLifetimeRetired = true;
  }

  /** Reversible drain and native joins retain audited reads within their owner's lifetime. */
  function isGatewayReadAdmissionAvailable(): boolean {
    if (
      state.writerRetired &&
      (Date.now() >= state.readerExpiresAtMs! || performance.now() >= state.readerDeadlineAtMs!)
    ) {
      retireGatewayReaderAdmission();
    }
    if (state.readerLifetimeRetired) {
      return false;
    }
    return (
      isGatewayReaderReady() ||
      (getGatewaySuspendAdmissionPhase() !== "accepting" &&
        (!isGatewayRestartDraining() || (isGatewayWriterRetired() && !state.writerSettled)))
    );
  }

  /** Audited core readers cannot borrow subordinate execution or continuation authority. */
  function tryBeginGatewayReaderRootWorkAdmission(
    origin: string,
  ): GatewayRootWorkAdmissionLease | null {
    if (!isGatewayReadAdmissionAvailable()) {
      return null;
    }
    const lease = createGatewayRootWorkAdmission(origin, false, true);
    return {
      ...lease,
      run: async (read) => {
        if (!isGatewayReadAdmissionAvailable()) {
          throw new owner.DrainingError("Gateway reader has retired");
        }
        return await lease.run(read);
      },
    };
  }

  return {
    retireGatewayWriterAdmission,
    publishGatewayReaderAdmission,
    runWithGatewayWriterRetirementCleanup,
    isGatewayReaderReady,
    isGatewayWriterRetired,
    isGatewayReadonlyWork,
    assertGatewaySqliteWriterAdmission,
    retireGatewayReaderAdmission,
    isGatewayReadAdmissionAvailable,
    tryBeginGatewayReaderRootWorkAdmission,
  };
}
