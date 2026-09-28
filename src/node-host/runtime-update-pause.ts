export function createNodeHostUpdatePause(params: {
  hasLocalActiveWork: () => boolean;
  hasWorkerActiveWork: () => Promise<boolean> | undefined;
}) {
  let updatePause: symbol | undefined;
  return {
    get isPaused() {
      return updatePause !== undefined;
    },
    async tryPauseForUpdate(this: void) {
      if (updatePause || params.hasLocalActiveWork()) {
        return false;
      }
      // Close invoke admission before the journal read yields. A resumed or
      // replaced pause cannot be claimed or cleared by this older attempt.
      const pause = Symbol("node-host-update-pause");
      updatePause = pause;
      let admitted = false;
      try {
        const workerBusy = await params.hasWorkerActiveWork();
        admitted = updatePause === pause && !workerBusy && !params.hasLocalActiveWork();
        return admitted;
      } finally {
        if (!admitted && updatePause === pause) {
          updatePause = undefined;
        }
      }
    },
    resumeAfterUpdate(this: void) {
      updatePause = undefined;
    },
  };
}
