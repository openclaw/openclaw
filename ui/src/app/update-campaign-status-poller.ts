/** Polls an active update campaign without overlapping timers. */
export function createUpdateCampaignStatusPoller(params: {
  canPoll: () => boolean;
  refresh: () => Promise<void>;
}) {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  const poll = async () => {
    timer = null;
    if (params.canPoll()) {
      await params.refresh();
    }
    // The owner retires polling eligibility before stopping; sync rechecks it after reads.
    sync();
  };
  const sync = () => {
    if (!params.canPoll()) {
      stop();
      return;
    }
    if (timer === null) {
      timer = globalThis.setTimeout(() => void poll(), 5_000);
    }
  };
  return { stop, sync };
}
