import { registerListener } from "../../../../src/shared/listeners.js";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { UiPreferences } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { trimHumanMentions, updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { MAX_STORED_QUEUE_ITEMS } from "../../lib/chat/outbox-store-codec.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { releaseChatAttachmentPayloads } from "../chat/attachment-payload-store.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";

registerNewSessionSetupEnglish();

type CreationComposerContext = {
  readonly gateway: ApplicationGateway;
  readonly config: ApplicationConfigCapability;
  readonly lifecycleAbortSignal?: AbortSignal;
  readonly theme?: { readonly settings: Pick<UiPreferences, "chatSendShortcut"> };
};

/** Before sessions.create accepts a destination these are inputs, not send attempts. */
export type CreationComposerInput = {
  id: string;
  text: string;
  mentions?: readonly HumanMention[];
  attachments: ChatAttachment[];
  createdAt: number;
};

export type CreationComposerTransfer = {
  sessionKey: string;
  draft: string;
  mentions: readonly HumanMention[];
  attachments: ChatAttachment[];
  reads: NewSessionAttachmentDraft["reads"];
  inputs: CreationComposerInput[];
  incognito: boolean;
  initialRejected: boolean;
  sessionId?: string;
  isCurrent: () => boolean;
  claimDraft: () => boolean;
  complete: () => void;
  onInvalidate: (listener: () => void) => () => void;
};

/** The retained New Session draft owns this buffer through rejection and reconnect. */
export class CreationComposer {
  readonly id = generateUUID();
  readonly attachmentDraft: NewSessionAttachmentDraft;
  message = "";
  mentions: readonly HumanMention[] = [];
  inputs: CreationComposerInput[] = [];
  error: string | null = null;
  flushInput: (() => void) | undefined;
  releasePresentation: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly invalidations = new Set<() => void>();
  private readonly gatewayUrl;
  private readonly recoveryScope;
  private readonly presentationScope;
  private readonly unregisterReload;
  private accepted: SessionCreateOutcome | undefined;
  private transferred = false;
  private transfer: CreationComposerTransfer | undefined;
  private disposed = false;

  constructor(
    readonly context: CreationComposerContext,
    readonly agentId: string,
    public incognito: boolean,
    private readonly notifyDraft: () => void,
  ) {
    this.gatewayUrl = context.gateway.connection.gatewayUrl;
    this.recoveryScope = context.gateway.snapshot.hello?.auth?.recoveryScope;
    this.presentationScope = gatewayPresentationScope(context.gateway);
    this.attachmentDraft = new NewSessionAttachmentDraft(this.notify, () => {
      this.error = null;
    });
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (this.hasInput) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    const unregister = registerControlUiReloadGuard(
      () => !this.hasInput,
      () => showToast({ message: t("newSession.followUpReloadBlocked") }),
    );
    this.unregisterReload = () => {
      unregister();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }

  get hasInput(): boolean {
    return Boolean(
      this.message ||
      this.inputs.length ||
      this.transfer?.inputs.length ||
      this.attachmentDraft.attachments.length ||
      this.attachmentDraft.reads.pendingReads,
    );
  }

  private ownsScope(): boolean {
    const { gateway } = this.context;
    return (
      Boolean(this.recoveryScope) &&
      gatewayPresentationScope(gateway) === this.presentationScope &&
      gateway.connection.gatewayUrl === this.gatewayUrl &&
      (gateway.snapshot.phase !== "connected" ||
        gateway.snapshot.hello?.auth?.recoveryScope === this.recoveryScope)
    );
  }

  canDisplay(): boolean {
    return !this.disposed && !this.transferred && this.ownsScope();
  }

  canRecover(): boolean {
    return !this.disposed && this.ownsScope() && this.accepted !== undefined;
  }

  get acceptedSessionKey(): string | undefined {
    return this.accepted?.key;
  }

  canAdopt(): boolean {
    // This is local custody, not send admission. The destination must keep its
    // draft even if connection recovery has not yet authorized outbox writes.
    return this.canDisplay() && this.accepted !== undefined;
  }

  readonly notify = () => {
    this.notifyDraft();
    for (const listener of this.listeners) {
      listener();
    }
  };

  subscribe(listener: () => void): () => void {
    return registerListener(this.listeners, listener);
  }

  setMessage(message: string, mentions?: readonly HumanMention[]): void {
    if (!this.canDisplay()) {
      return;
    }
    this.mentions = mentions ?? updateHumanMentions(this.message, message, this.mentions);
    this.message = message;
    this.error = null;
    this.notify();
  }

  enqueue(): boolean {
    if (!this.canDisplay() || this.attachmentDraft.reads.pendingReads) {
      return false;
    }
    const submitted = trimHumanMentions(this.message, this.mentions);
    if (!submitted.text && !this.attachmentDraft.attachments.length) {
      return false;
    }
    if (/^[!/]/u.test(submitted.text)) {
      this.error = t("newSession.followUpCommandsUnavailable");
    } else if (this.inputs.length >= MAX_STORED_QUEUE_ITEMS) {
      this.error = t("chat.queue.full");
    } else if (this.attachmentDraft.attachments.length && !uploadsEnabled(this.context.config)) {
      this.error = uploadsDisabledMessage();
    } else {
      const input: CreationComposerInput = {
        id: generateUUID(),
        text: submitted.text,
        ...(submitted.mentions?.length ? { mentions: submitted.mentions } : {}),
        attachments: this.attachmentDraft.take(),
        createdAt: Date.now(),
      };
      this.inputs = [...this.inputs, input];
      this.message = "";
      this.mentions = [];
      this.error = null;
      this.notify();
      return true;
    }
    this.notify();
    return false;
  }

  remove(id: string): void {
    if (!this.canDisplay()) {
      return;
    }
    const input = this.inputs.find((entry) => entry.id === id);
    this.inputs = this.inputs.filter((entry) => entry !== input);
    releaseChatAttachmentPayloads(input?.attachments ?? []);
    this.notify();
  }

  accept(result: SessionCreateOutcome): void {
    this.accepted = result;
  }

  take(onComplete: () => void = () => {}): CreationComposerTransfer | undefined {
    if (this.transfer) {
      return this.canRecover() ? this.transfer : undefined;
    }
    if (!this.canAdopt()) {
      return undefined;
    }
    this.flushInput?.();
    let draftClaimed = false;
    const transfer: CreationComposerTransfer = {
      sessionKey: this.accepted!.key,
      draft: this.message,
      mentions: this.mentions,
      attachments: this.attachmentDraft.attachments,
      reads: this.attachmentDraft.reads,
      inputs: this.inputs,
      incognito: this.incognito,
      isCurrent: () => !this.disposed && this.ownsScope(),
      claimDraft: () => {
        if (draftClaimed) {
          return false;
        }
        draftClaimed = true;
        return true;
      },
      onInvalidate: (listener) => {
        if (this.disposed) {
          listener();
          return () => {};
        }
        return registerListener(this.invalidations, listener);
      },
      complete: () => {
        this.invalidations.clear();
        this.unregisterReload();
        this.transfer = undefined;
        onComplete();
      },
      initialRejected: this.accepted!.initialRun.status === "rejected",
      ...(typeof this.accepted!.entry?.sessionId === "string"
        ? { sessionId: this.accepted!.entry.sessionId }
        : {}),
    };
    this.transfer = transfer;
    this.transferred = true;
    this.inputs = [];
    this.message = "";
    this.mentions = [];
    this.attachmentDraft.attachments = [];
    this.flushInput = undefined;
    this.releasePresentation?.();
    this.releasePresentation = undefined;
    return transfer;
  }

  /** Accepted custody stays app-scoped until the outbox admits or discards every input. */
  releaseDraft(): void {
    if (!this.accepted) {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.invalidations) {
      listener();
    }
    this.invalidations.clear();
    this.transfer = undefined;
    this.unregisterReload();
    if (this.transferred) {
      this.listeners.clear();
      return;
    }
    this.flushInput = undefined;
    this.releasePresentation?.();
    this.releasePresentation = undefined;
    this.attachmentDraft.reset();
    for (const input of this.inputs) {
      releaseChatAttachmentPayloads(input.attachments);
    }
    this.inputs = [];
    this.message = "";
    this.mentions = [];
    this.listeners.clear();
  }
}

// Accepted input stays app-scoped, but only the lazy creation/chat surfaces load its owner.
const acceptedComposers = new WeakMap<
  CreationComposerContext,
  { entries: Map<string, CreationComposer>; release: () => void }
>();

export function retainCreatedComposer(
  context: CreationComposerContext,
  key: string,
  composer: CreationComposer,
): void {
  let registry = acceptedComposers.get(context);
  if (!registry) {
    const entries = new Map<string, CreationComposer>();
    const dispose = () => {
      for (const value of entries.values()) {
        value.dispose();
      }
      entries.clear();
      registry?.release();
    };
    const unsubscribe = context.gateway.subscribe(() => {
      for (const [entryKey, value] of entries) {
        if (!value.canRecover()) {
          value.dispose();
          entries.delete(entryKey);
        }
      }
      if (!entries.size) {
        registry?.release();
      }
    });
    registry = {
      entries,
      release: () => {
        unsubscribe();
        context.lifecycleAbortSignal?.removeEventListener("abort", dispose);
        if (acceptedComposers.get(context) === registry) {
          acceptedComposers.delete(context);
        }
      },
    };
    acceptedComposers.set(context, registry);
    context.lifecycleAbortSignal?.addEventListener("abort", dispose, { once: true });
  }
  const previous = registry.entries.get(key);
  if (previous && previous !== composer) {
    previous.dispose();
  }
  registry.entries.set(key, composer);
}

export function takeCreatedComposer(
  context: CreationComposerContext,
  sessionKey: string,
  client: object | null,
): CreationComposerTransfer | undefined {
  const registry = acceptedComposers.get(context);
  const key =
    registry &&
    [...registry.entries.keys()].find((candidate) =>
      areUiSessionKeysEquivalent(candidate, sessionKey),
    );
  const composer = key ? registry?.entries.get(key) : undefined;
  if (
    !registry ||
    !key ||
    !composer ||
    client !== context.gateway.snapshot.client ||
    !composer.canRecover()
  ) {
    return undefined;
  }
  return composer.take(() => {
    if (registry.entries.get(key) === composer) {
      registry.entries.delete(key);
    }
    if (!registry.entries.size) {
      registry.release();
    }
  });
}
