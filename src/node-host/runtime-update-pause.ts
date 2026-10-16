export function createNodeHostUpdatePause(params: {
  hasLocalActiveWork: () => boolean;
  hasWorkerActiveWork: () => Promise<boolean> | undefined;
}) {
  let updatePause = false;
  return {
    get isPaused() {
      return updatePause;
    },
    async tryPauseForUpdate(this: void) {
      if (updatePause || params.hasLocalActiveWork()) {
        return false;
      }
      // The update loop awaits this check before resuming; close invoke admission first.
      updatePause = true;
      let admitted = false;
      try {
        const workerBusy = await params.hasWorkerActiveWork();
        admitted = !workerBusy && !params.hasLocalActiveWork();
        return admitted;
      } finally {
        if (!admitted) {
          updatePause = false;
        }
      }
    },
    resumeAfterUpdate(this: void) {
      updatePause = false;
    },
  };
}
