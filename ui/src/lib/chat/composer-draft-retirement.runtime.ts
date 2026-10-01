import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { deleteStoredChatSessionSnapshots } from "../../pages/chat/session-snapshot-invalidation.runtime.ts";
import { showToast } from "../toast.ts";
import { retireDurableComposerDrafts } from "./composer-draft-store.runtime.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import { storedChatOutboxScopeKey } from "./outbox-store.ts";

type DeletedComposerDraftScope = Parameters<typeof deleteStoredChatSessionSnapshots>[0] & {
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  gatewayUrl: string | undefined;
  isCurrent: () => boolean;
};

export async function retireDeletedComposerDrafts(
  context: ApplicationContext,
  scope: DeletedComposerDraftScope,
  targets: Parameters<typeof retireStoredComposerDrafts>[1],
): Promise<void> {
  try {
    if (scope.client && !scope.client.recoveryScopeReady && scope.isCurrent()) {
      let unsubscribe = () => {};
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Draft recovery scope unavailable")), 10_000);
        const onReady = () => {
          if (scope.client?.recoveryScopeReady || !scope.isCurrent()) {
            resolve();
          }
        };
        unsubscribe = context.gateway.subscribe(onReady);
        onReady();
      }).finally(() => {
        clearTimeout(timeout);
        unsubscribe();
      });
    }
    if (!scope.client || !scope.isCurrent()) {
      throw new Error("Draft cleanup connection changed");
    }
    const { recoveryScope, recoveryScopeReady } = scope.client;
    const stored = retireStoredComposerDrafts(
      { settings: { gatewayUrl: scope.gatewayUrl } },
      targets,
    );
    const retirements = stored.retirements.map((retirement) => ({
      scopeKey: `chat:v3:${storedChatOutboxScopeKey(retirement.scope)}`,
      minimumRevision: retirement.minimumRevision,
      retireBeforeRevision: retirement.retireBeforeRevision,
    }));
    const [, durable] = await Promise.all([
      deleteStoredChatSessionSnapshots(scope, targets),
      recoveryScopeReady && recoveryScope
        ? retireDurableComposerDrafts(
            { gatewayOwner: stored.gatewayOwner, recoveryScope },
            retirements,
          )
        : "storage-failed",
    ]);
    if (stored.storageFailed || durable === "storage-failed") {
      throw new Error("Draft storage cleanup failed");
    }
  } catch {
    showToast({ message: t("sessionsView.draftCleanupFailed") });
  }
}
