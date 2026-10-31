import type { DiagnosticsPrepareResult } from "../../../packages/gateway-protocol/src/schema/diagnostics.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { readBlobAsDataUrl } from "../lib/blob-data-url.ts";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store-scope.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { resolveUiSelectedGlobalAgentId } from "../lib/sessions/session-key.ts";
import { assertUploadsEnabled } from "../lib/uploads.ts";
import {
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "../pages/chat/attachment-payload-store.ts";
import {
  admitAttachmentFiles,
  resolveChatAttachmentLimits,
} from "../pages/chat/components/chat-attachment-admission.ts";
import { reviewPrivateComposerDraft } from "../pages/chat/components/private-composer-recovery-dialog.tsx";

/** Preparation never contributes a user turn; the chat composer owns the first send. */
async function openDiagnosticSession(
  context: ApplicationContext,
  agentId: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<boolean> {
  const client = context.gateway.snapshot.client;
  if (!client || !isCurrent()) {
    return false;
  }
  assertUploadsEnabled(context.config);
  const prepared = await client.request<DiagnosticsPrepareResult>(
    "diagnostics.prepare",
    { agentId },
    { signal, timeoutMs: 45_000 },
  );
  if (!isCurrent()) {
    return false;
  }
  const file = new File([prepared.context], "openclaw-diagnostics.txt", { type: "text/plain" });
  if (
    !admitAttachmentFiles(
      [file],
      resolveChatAttachmentLimits(context.gateway.snapshot.hello?.policy),
      0,
    ).length
  ) {
    return false;
  }
  const dataUrl = await readBlobAsDataUrl(file);
  if (!isCurrent()) {
    return false;
  }
  assertUploadsEnabled(context.config);
  const params = {
    agentId: prepared.agentId,
    cwd: prepared.cwd,
    displayName: t("palette.items.diagnose"),
  };
  const access = readSessionMethodAccess(context.gateway.snapshot, {
    method: "sessions.create",
    params,
    sessionScope: true,
  });
  if (!access.allowed) {
    throw new Error(access.reason);
  }
  const result = await context.sessions.createResult(params, {
    signal,
    reconciliation: "background",
  });
  if (!result || !isCurrent()) {
    return false;
  }
  const attachment = registerChatAttachmentPayload({
    attachment: {
      id: generateAttachmentId(),
      mimeType: file.type,
      fileName: file.name,
      sizeBytes: file.size,
      origin: "file",
    },
    dataUrl,
    file,
  });
  context.chatAttachmentHandoff.prepare({
    owner: client,
    paneId: null,
    scopeKey: storedChatOutboxScopeKey({ sessionKey: result.key, agentId: prepared.agentId }),
    attachments: [attachment],
    fallbacks: {},
    reviewPrivateDraft: reviewPrivateComposerDraft,
  });
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: result.key,
    agentId: prepared.agentId,
    exactKey: true,
    focusComposer: true,
  });
  selectApplicationSession({
    selection: context.agentSelection,
    gateway: context.gateway,
    sessionKey: result.key,
    agentId: prepared.agentId,
  });
  context.navigate("chat", target.options);
  return true;
}

/** The launcher owns cancellation; session creation keeps its canonical mutation owner. */
export class CommandPaletteDiagnostics {
  private operation: AbortController | undefined;
  error: string | null = null;

  constructor(
    private readonly context: ApplicationContext,
    private readonly canStart: () => boolean,
    private readonly changed: () => void,
    private readonly close: () => void,
  ) {}

  get pending() {
    return Boolean(this.operation);
  }
  get available() {
    const snapshot = this.context.gateway.snapshot;
    return (
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "diagnostics.prepare") === true
    );
  }

  cancel() {
    this.operation?.abort();
    this.operation = undefined;
    this.error = null;
  }

  readonly start = async () => {
    if (!this.canStart() || this.operation || !this.available) {
      return;
    }
    const operation = new AbortController();
    const client = this.context.gateway.snapshot.client;
    const scope = gatewayPresentationScope(this.context.gateway);
    const isCurrent = () =>
      this.canStart() &&
      this.operation === operation &&
      !operation.signal.aborted &&
      this.context.gateway.snapshot.client === client &&
      gatewayPresentationScope(this.context.gateway) === scope &&
      this.available;
    this.operation = operation;
    this.error = null;
    this.changed();
    try {
      const opened = await openDiagnosticSession(
        this.context,
        this.context.agentSelection.state.selectedId ??
          resolveUiSelectedGlobalAgentId(this.context.gateway.snapshot),
        operation.signal,
        isCurrent,
      );
      if (opened && isCurrent()) {
        this.close();
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.operation === operation) {
        this.operation = undefined;
      }
      this.changed();
    }
  };
}
