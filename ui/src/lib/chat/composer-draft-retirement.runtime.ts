import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { retireSessionPaneHandoffs } from "../../pages/chat/chat-pane-shared.ts";
import { deleteStoredChatSessionSnapshots } from "../../pages/chat/session-snapshot-invalidation.runtime.ts";
import { showToast } from "../toast.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import { storedChatOutboxScopeKey } from "./outbox-store.ts";

type DeletedComposerDraftTarget = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

type DeletedComposerDraftScope = Parameters<typeof deleteStoredChatSessionSnapshots>[0] & {
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  gatewayUrl: string | undefined;
  isCurrent: () => boolean;
};

export async function retireDeletedComposerDrafts(
  context: ApplicationContext,
  scope: DeletedComposerDraftScope,
  targets: readonly DeletedComposerDraftTarget[],
): Promise<void> {
  let failureReported = false;
  const reportFailure = () => {
    if (!failureReported) {
      failureReported = true;
      showToast({ message: t("sessionsView.draftCleanupFailed") });
    }
  };
  try {
    const { retireDurableComposerDrafts } = await import("./composer-draft-store.runtime.ts");
    if (scope.client && !scope.client.recoveryScopeReady && scope.isCurrent()) {
      await new Promise<void>((resolve) => {
        let unsubscribe = () => {};
        const onReady = () => {
          if (scope.client?.recoveryScopeReady || !scope.isCurrent()) {
            unsubscribe();
            resolve();
          }
        };
        unsubscribe = context.gateway.subscribe(onReady);
        onReady();
      });
    }
    if (!scope.client || !scope.isCurrent()) {
      reportFailure();
      return;
    }
    // Readiness can settle during either import without replacing the connection.
    const { recoveryScope, recoveryScopeReady } = scope.client;
    void deleteStoredChatSessionSnapshots(scope, targets).catch(reportFailure);
    const stored = retireStoredComposerDrafts(
      { settings: { gatewayUrl: scope.gatewayUrl } },
      targets,
    );
    retireSessionPaneHandoffs(context, targets, scope.client, recoveryScope);
    for (const retirement of stored.retirements) {
      context.chatAttachmentHandoff.retireScope(
        storedChatOutboxScopeKey(retirement.scope),
        retirement.retireBeforeRevision,
        scope.client,
        recoveryScope,
      );
    }
    let failed = stored.storageFailed;
    if (!recoveryScopeReady || !recoveryScope) {
      failed = true;
    } else {
      const owner = { gatewayOwner: stored.gatewayOwner, recoveryScope };
      const retirements = stored.retirements.map((retirement) => ({
        scopeKey: `chat:v3:${storedChatOutboxScopeKey(retirement.scope)}`,
        minimumRevision: retirement.minimumRevision,
        retireBeforeRevision: retirement.retireBeforeRevision,
      }));
      const durable = await retireDurableComposerDrafts(owner, retirements);
      failed ||= durable === "storage-failed";
    }
    if (failed) {
      reportFailure();
    }
  } catch {
    reportFailure();
  }
}
