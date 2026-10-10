import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";

export type ChannelStartFence = {
  state: "paused" | "published" | "failed";
  snapshot?: {
    listedAccountIds: ReadonlySet<string>;
    read: () => {
      accounts: Record<string, ChannelAccountSnapshot>;
      defaultAccountId: string;
      defaultAccount: ChannelAccountSnapshot;
    };
  };
};

/** A settled failure retains diagnostic facts without retaining a reload pause. */
export function pauseChannelStarts(
  channelIds: Iterable<ChannelId>,
  getStore: (channelId: ChannelId) => { startFence?: ChannelStartFence },
  captureSnapshot: (channelId: ChannelId) => ChannelStartFence["snapshot"],
) {
  const reservations = [...new Set(channelIds)].map((channelId) => {
    const store = getStore(channelId);
    const previous = store.startFence;
    const fence: ChannelStartFence = {
      state: "paused",
      snapshot:
        previous && previous.state !== "published" ? previous.snapshot : captureSnapshot(channelId),
    };
    return { channelId, store, previous, fence };
  });
  // Capture every target before pausing any of them; a failed capture must not strand a sibling.
  for (const { store, fence } of reservations) {
    store.startFence = fence;
  }
  return (outcome: "published" | "rollback" | "failed", selected?: ReadonlySet<ChannelId>) => {
    for (const { channelId, store, previous, fence } of reservations) {
      if (selected && !selected.has(channelId)) {
        continue;
      }
      if (store.startFence === fence && fence.state === "paused") {
        // Keep the token on settlement so delayed predecessor preparation stays stale.
        // A cancelled retry restores the previous operation's recorded state.
        if (outcome !== "rollback") {
          fence.state = outcome;
        } else {
          store.startFence = previous;
        }
      }
    }
  };
}
