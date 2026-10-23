import type { SqliteWorkerCloseReceipt } from "../infra/sqlite-worker-contract.js";

export function createAgentNativeStopObservation() {
  let stopped: Promise<void> | undefined;
  let readCloseReceipt: (() => SqliteWorkerCloseReceipt | undefined) | undefined;
  let readOpenRefused: (() => boolean) | undefined;

  return {
    observe: (
      nextStopped: Promise<void>,
      nextReadCloseReceipt: () => SqliteWorkerCloseReceipt | undefined,
      nextReadOpenRefused: () => boolean,
    ): void => {
      stopped = nextStopped;
      readCloseReceipt = nextReadCloseReceipt;
      readOpenRefused = nextReadOpenRefused;
    },
    get stopped() {
      return stopped;
    },
    get readCloseReceipt() {
      return readCloseReceipt;
    },
    get readOpenRefused() {
      return readOpenRefused;
    },
  };
}
