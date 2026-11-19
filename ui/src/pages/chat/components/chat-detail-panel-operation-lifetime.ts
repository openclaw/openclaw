import { action, createOptimistic } from "solid-js";
import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";
import type { ChatDetailPanel, ChatDetailPanelProps } from "./chat-sidebar-view-types.ts";

const retireOperations = new WeakMap<
  ChatDetailPanel,
  { update: () => void; disconnect: () => void }
>();

export function registerDetailPanelRetirement(
  host: ChatDetailPanel,
  previousContent: () => ChatDetailPanelContent | null | undefined,
  previousRuntime: () => AttachmentSidebarRuntime | undefined,
  retire: () => void,
  retireAttachment: (next?: ChatDetailPanelProps) => void,
) {
  const update = () => {
    retireAttachment(host);
    const runtime = previousRuntime();
    const current = host.attachmentRuntime;
    if (
      !host.isConnected ||
      host.content !== previousContent() ||
      current.connectionEpoch !== runtime?.connectionEpoch ||
      current.sessionKey !== runtime?.sessionKey ||
      current.agentId !== runtime?.agentId
    ) {
      retire();
    }
  };
  retireOperations.set(host, {
    update,
    disconnect: () => {
      retireAttachment();
      retire();
    },
  });
  return () => retireOperations.delete(host);
}

export const detailPanelOperationLifetime = {
  propertyChanged(host: ChatDetailPanel, key: keyof ChatDetailPanelProps) {
    if (
      key === "content" ||
      key === "attachmentRuntime" ||
      key === "attachmentChat" ||
      key === "filePresented" ||
      key === "fileWorkspace"
    ) {
      retireOperations.get(host)?.update();
    }
  },
  disconnected(host: ChatDetailPanel) {
    queueMicrotask(() => {
      if (!host.isConnected) {
        retireOperations.get(host)?.disconnect();
      }
    });
  },
};

/** Present admitted work without retaining a replaced panel's transition. */
export function createDetailOperationPresentation() {
  const [pending, setPending] = createOptimistic(false);
  let lifetime = Promise.withResolvers<void>();
  const present = action(function* (
    completion: Promise<unknown>,
    retired: Promise<void>,
    current: () => boolean,
  ) {
    if (current()) {
      setPending(true);
    }
    yield Promise.race([completion, retired]);
  });
  return {
    pending,
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    async observe(completion: Promise<unknown>, current: () => boolean) {
      const admitted = lifetime;
      await Promise.resolve();
      return present(completion, admitted.promise, () => admitted === lifetime && current());
    },
  };
}
