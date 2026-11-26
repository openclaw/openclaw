import {
  createDefaultWritingProfileCatalog,
  resolveWritingProfile,
  writingProfileDiagnostics,
  type WritingProfileCatalog,
  type WritingProfileSnapshot,
} from "../../../../src/shared/dictation-writing-profiles.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  loadWritingProfilePreferences,
  WRITING_PROFILES_PREFERENCE_KEY,
} from "../../app/dictation-writing-profile-preferences.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { invalidateUserPreferences } from "../../app/user-prefs-cache.ts";

const ORIGINAL_TEXT_LIMIT = 65_536;

export type DictationProfileCapture = Readonly<{
  generation: number;
  epoch: object;
  snapshot: WritingProfileSnapshot;
}>;

type Outcome = "none" | "committed" | "not-applied" | "unknown" | "preview" | "stale";
type Receipt = {
  capture: DictationProfileCapture;
  outcome: Outcome;
  original: string | null;
  draft: string | undefined;
};

/**
 * Metadata for the existing dictation owner. Capture and the FIFO commit queue
 * still own requests and effects; this class never starts a provider or writes a draft.
 */
export class ComposerDictationProfiles {
  catalog: WritingProfileCatalog = createDefaultWritingProfileCatalog();
  overrideId: string | null = null;
  disabled = false;
  loadStatus: "idle" | "loading" | "ready" | "unavailable" | "error" = "idle";
  private gateway: ApplicationGateway | undefined;
  private client: GatewayBrowserClient | null = null;
  private profileId: string | null = null;
  private connectionGeneration: number | undefined;
  private authority: object = {};
  private request: object = {};
  private loadPromise: Promise<void> = Promise.resolve();
  private initialized = false;
  private epoch: object = {};
  private generation = 0;
  private removeGateway: (() => void) | undefined;
  private removeEvents: (() => void) | undefined;
  private captureAllowed = false;
  private providerAllowed = false;
  private readDraft: (() => string) | undefined;
  private receipt: Receipt | undefined;
  private activeCapture: DictationProfileCapture | undefined;

  constructor(
    private readonly changed: () => void,
    private readonly retireCapture: () => void,
    private readonly busy: () => boolean,
  ) {}

  get selection(): WritingProfileSnapshot {
    return resolveWritingProfile({
      catalog:
        this.disabled || this.loadStatus !== "ready"
          ? { ...this.catalog, enabled: false }
          : this.catalog,
      overrideId: this.overrideId,
      context: {
        revision: "control-ui-composer-v1",
        consentRevision: "external-context-disabled",
        policyRevision: "composer-only",
        field: "editable",
        application: { supported: false, consent: false, trusted: false, identity: null },
        origin: { supported: false, consent: false, trusted: false, value: null },
      },
      // The shipped transcription relay exposes no M01–M04 processing contract.
      capabilities: { revision: "transcription-only-v1", transforms: [], locales: [] },
      restrictions: {
        revision: `${this.captureAllowed}:${this.providerAllowed}`,
        captureAllowed: this.captureAllowed,
        providerAllowed: this.providerAllowed,
        refinementAllowed: false,
        allowedTransforms: [],
        forceLiteral: true,
      },
    });
  }

  get original(): string | null {
    return this.receipt?.original ?? null;
  }

  get lastSnapshot(): WritingProfileSnapshot | null {
    return this.receipt?.capture.epoch === this.epoch ? this.receipt.capture.snapshot : null;
  }

  get activeSnapshot(): WritingProfileSnapshot | null {
    return this.activeCapture?.snapshot ?? null;
  }

  get outcome(): Outcome {
    return this.receipt?.outcome ?? "none";
  }

  get diagnostics() {
    return {
      ...writingProfileDiagnostics(this.activeSnapshot ?? this.lastSnapshot ?? this.selection),
      generation: this.generation,
      outcome: this.outcome,
    };
  }

  get publicationScope(): object {
    return this.epoch;
  }

  sync(options: {
    gateway?: ApplicationGateway;
    client: GatewayBrowserClient | null;
    enabled: boolean;
    realtimeTalkActive: boolean;
    dictationAvailable?: boolean;
    readDraft?: () => string;
  }): void {
    const captureAllowed =
      options.enabled && !options.realtimeTalkActive && options.client !== null;
    if (this.captureAllowed && !captureAllowed) {
      this.retireCapture();
    }
    this.captureAllowed = captureAllowed;
    this.providerAllowed = options.dictationAvailable !== false;
    this.readDraft = options.readDraft;
    if (this.gateway !== options.gateway || this.client !== options.client) {
      this.removeGateway?.();
      this.removeEvents?.();
      this.gateway = options.gateway;
      this.client = options.client;
      this.profileId =
        this.gateway?.snapshot.client === this.client
          ? (this.gateway?.snapshot.selfUser?.id ?? null)
          : null;
      this.connectionGeneration = this.client?.connectionGeneration;
      this.retireScope(this.initialized);
      this.initialized = true;
      this.removeGateway = this.gateway?.subscribe(() => this.syncScope());
      this.removeEvents = this.gateway?.subscribeEvents((event) => {
        if (event.event !== "users.prefs.changed" || !this.client) {
          return;
        }
        const payload = event.payload;
        if (
          payload &&
          typeof payload === "object" &&
          "profileId" in payload &&
          payload.profileId === this.profileId &&
          "keys" in payload &&
          Array.isArray(payload.keys) &&
          payload.keys.includes(WRITING_PROFILES_PREFERENCE_KEY)
        ) {
          invalidateUserPreferences(this.client);
          this.loadPromise = this.load();
        }
      });
      this.loadPromise = this.load();
    }
    this.syncScope();
  }

  private syncScope(): void {
    const snapshot = this.gateway?.snapshot;
    const profileId = snapshot?.client === this.client ? (snapshot?.selfUser?.id ?? null) : null;
    const generation = this.client?.connectionGeneration;
    if (profileId !== this.profileId || generation !== this.connectionGeneration) {
      this.retireScope();
      this.profileId = profileId;
      this.connectionGeneration = generation;
      this.loadPromise = this.load();
    }
  }

  private retireScope(notifyOwner = true): void {
    this.authority = {};
    this.request = {};
    this.catalog = createDefaultWritingProfileCatalog();
    this.overrideId = null;
    this.disabled = false;
    this.loadStatus = "idle";
    this.retire();
    if (notifyOwner) {
      this.retireCapture();
    }
    this.changed();
  }

  ready(): Promise<void> {
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    const client = this.client;
    const profileId = this.profileId;
    if (!client || !profileId) {
      this.loadStatus = "unavailable";
      this.changed();
      return;
    }
    const request = (this.request = {});
    const authority = this.authority;
    const isCurrent = () => this.request === request && this.authority === authority;
    this.loadStatus = "loading";
    this.changed();
    const result = await loadWritingProfilePreferences(client, profileId, { isCurrent });
    if (!isCurrent()) {
      return;
    }
    if (result.status === "ok") {
      this.catalog = result.current.catalog ?? createDefaultWritingProfileCatalog();
      this.loadStatus = result.current.catalog ? "ready" : "unavailable";
    } else {
      // A failed refresh cannot authorize another capture with stale preferences.
      this.catalog = createDefaultWritingProfileCatalog();
      this.loadStatus = result.status === "error" ? "error" : "unavailable";
    }
    this.changed();
  }

  select(id: string | null): void {
    if (
      id !== null &&
      !this.catalog.profiles.some((profile) => profile.id === id && profile.enabled)
    ) {
      return;
    }
    this.overrideId = id;
    this.disabled = false;
    this.changed();
  }

  disable(): void {
    this.disabled = true;
    this.changed();
  }

  resetSession(): void {
    this.overrideId = null;
    this.disabled = false;
  }

  abandon(capture: DictationProfileCapture | undefined): void {
    if (this.activeCapture === capture) {
      this.activeCapture = undefined;
      this.changed();
    }
  }

  begin(): DictationProfileCapture | null {
    const snapshot = this.selection;
    if (!snapshot.captureAllowed) {
      return null;
    }
    return (this.activeCapture = Object.freeze({
      generation: ++this.generation,
      epoch: this.epoch,
      snapshot,
    }));
  }

  /** Called only by the existing FIFO at its single synchronous publication boundary. */
  deliver(capture: DictationProfileCapture, text: string, commit: () => boolean): boolean {
    if (this.activeCapture === capture) {
      this.activeCapture = undefined;
    }
    if (capture.epoch !== this.epoch || !this.captureAllowed || !text) {
      return false;
    }
    const receipt: Receipt = {
      capture,
      outcome: "unknown",
      // M05 adds no app/origin/style context. Existing provider configuration may
      // supply transcription hints; this receipt does not assert independent STT.
      original: text.length <= ORIGINAL_TEXT_LIMIT ? text : null,
      draft: undefined,
    };
    this.receipt = receipt;
    try {
      receipt.outcome = commit() ? "committed" : "not-applied";
      if (capture.epoch === this.epoch && receipt.outcome === "committed") {
        const draft = this.readDraft?.();
        receipt.draft =
          draft !== undefined && draft.length <= ORIGINAL_TEXT_LIMIT ? draft : undefined;
      }
    } catch {
      // A callback may throw after an indivisible write. Never retry an unknown effect.
      receipt.outcome = "unknown";
    }
    this.changed();
    return receipt.outcome === "committed";
  }

  /** Explicit review only. There is no semantic processor to apply to this draft. */
  reprocess(): boolean {
    const receipt = this.receipt;
    if (
      !receipt?.original ||
      receipt.capture.epoch !== this.epoch ||
      this.busy() ||
      (receipt.outcome !== "committed" && receipt.outcome !== "preview") ||
      receipt.draft === undefined ||
      receipt.draft !== this.readDraft?.()
    ) {
      return false;
    }
    const capture = this.begin();
    if (!capture) {
      return false;
    }
    this.receipt = { ...receipt, capture, outcome: "preview" };
    this.activeCapture = undefined;
    this.changed();
    return true;
  }

  retire(): void {
    this.epoch = {};
    this.activeCapture = undefined;
    if (this.receipt) {
      // Preserve the actual effect receipt but release all recoverable content.
      this.receipt.original = null;
      this.receipt.draft = undefined;
    }
  }

  dispose(): void {
    this.request = {};
    this.removeGateway?.();
    this.removeEvents?.();
    this.retire();
  }
}
