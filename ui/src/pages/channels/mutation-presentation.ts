import { action, createMemo, createOptimisticStore, onSettled } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { showToast } from "../../lib/toast.ts";

export type ChannelMutation = "config" | "pairing" | "whatsapp" | "wizard";

/** Presents admitted work without changing its owner's write or settlement policy. */
export function createChannelMutations(deps: {
  readEpoch: () => number;
  currentEpoch: () => number;
  isActive: () => boolean;
}) {
  const epoch = createMemo(deps.readEpoch);
  const presentation = createMemo(() => {
    const currentEpoch = epoch();
    const [busy, setBusy] = createOptimisticStore({
      config: false,
      pairing: false,
      whatsapp: false,
      wizard: false,
    });
    return { epoch: currentEpoch, busy, setBusy };
  });
  const lifetimes = {
    config: Promise.withResolvers<void>(),
    pairing: Promise.withResolvers<void>(),
    whatsapp: Promise.withResolvers<void>(),
    wizard: Promise.withResolvers<void>(),
  };
  const isCurrent = (view: ReturnType<typeof presentation>) =>
    deps.isActive() && view.epoch === deps.currentEpoch();
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    kind: ChannelMutation,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    try {
      if (isCurrent(view)) {
        view.setBusy((busy) => {
          busy[kind] = true;
        });
      }
      // Leaving the presentation never cancels an already admitted write.
      yield Promise.race([pending, retired]);
    } catch (error) {
      if (isCurrent(view)) {
        showToast({ message: formatUiError(error) });
      }
    }
  });
  return {
    busy: () => presentation().busy,
    retire(kind?: ChannelMutation) {
      for (const key of kind ? [kind] : (["config", "pairing", "whatsapp", "wizard"] as const)) {
        lifetimes[key].resolve();
        lifetimes[key] = Promise.withResolvers<void>();
      }
    },
    async run(kind: ChannelMutation, pending: Promise<unknown>) {
      const view = presentation();
      const retired = lifetimes[kind].promise;
      // Let owner publication and any newly opened modal mount before joining the action.
      await new Promise<void>((resolve) => {
        onSettled(resolve);
      });
      return present(view, kind, pending, retired);
    },
  };
}
