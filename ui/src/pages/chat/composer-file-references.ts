import {
  FILE_REFERENCE_MAX_QUERY_BYTES,
  FILE_REFERENCE_NAMESPACE,
  isFileReferenceResult,
  type FileReference,
  type FileReferenceCapability,
  type SessionsFilesReferencesParams,
} from "../../../../src/shared/file-references.ts";
import {
  prepareFileReferenceDestination,
  type FileReferenceDestination,
} from "../../lib/chat/file-reference-destination.ts";
import { fileReferenceText } from "../../lib/chat/file-references.ts";
import {
  recognizeDictatedFileReferences,
  type DictatedFileCommand,
} from "../../lib/dictation-file-references.ts";
import { isComposerFileReferenceEligible } from "./components/chat-composer-file-reference-options.ts";
import type { ChatComposerProps, ChatComposerState } from "./components/chat-composer-types.ts";

export type FileReferenceSource = {
  client: object | null;
  connected: boolean;
  sessionKey: string;
  agentId: string;
  draft: string;
  revision: number;
  target: HTMLTextAreaElement | null;
  locale: string;
  eligible: boolean;
  request(params: SessionsFilesReferencesParams): Promise<unknown>;
};

export function readComposerFileReferenceSource(
  props: ChatComposerProps,
  state: Pick<ChatComposerState, "editRevision" | "composerTextarea">,
): FileReferenceSource {
  const client = props.gatewayClient ?? null;
  return {
    client,
    connected: props.connected,
    sessionKey: props.sessionKey,
    agentId: props.currentAgentId,
    draft: props.getDraft?.() ?? props.draft,
    revision: state.editRevision,
    target: state.composerTextarea,
    // The opt-in control explicitly selects the English command grammar.
    locale: "en-US",
    eligible: isComposerFileReferenceEligible(props),
    request: (params) =>
      client
        ? client.request("sessions.files.references", params)
        : Promise.reject(new Error("File reference provider unavailable")),
  };
}

export type DictationReferenceReceipt = {
  target: HTMLTextAreaElement;
  text: string;
  complete: boolean;
  from: number;
  to: number;
  previousValue: string;
  value: string;
};

type Phase =
  | "idle"
  | "preparing"
  | "searching"
  | "choosing"
  | "confirming"
  | "committed"
  | "copied"
  | "denied"
  | "unsupported"
  | "stale"
  | "expired"
  | "offline"
  | "no-matches"
  | "copy-failed"
  | "conversion-failed"
  | "outcome-unknown";

type Review = {
  generation: number;
  source: FileReferenceSource;
  expectedText: string;
  expectedRevision: number;
  context: SessionsFilesReferencesParams["context"];
  commands: DictatedFileCommand[];
  command: number;
  destination: FileReferenceDestination | null;
  snapshot: ReturnType<FileReferenceDestination["snapshot"]> | null;
};

type FileReferenceAction<T = SessionsFilesReferencesParams> = T extends unknown
  ? Omit<T, "schemaVersion" | "sessionKey" | "agentId" | "context">
  : never;

function sameCapability(left: FileReferenceCapability, right: FileReferenceCapability) {
  return (
    left.leaseId === right.leaseId &&
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.authorizationRevision === right.authorizationRevision &&
    left.resolverRevision === right.resolverRevision &&
    left.rootLabel === right.rootLabel &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.namespace === right.namespace &&
    left.providerId === right.providerId
  );
}

function belongs(reference: FileReference, capability: FileReferenceCapability) {
  return (
    reference.namespace === capability.namespace &&
    reference.providerId === capability.providerId &&
    reference.accountId === capability.accountId &&
    reference.workspaceId === capability.workspaceId &&
    reference.authorizationRevision === capability.authorizationRevision &&
    reference.resolverRevision === capability.resolverRevision &&
    reference.rootLabel === capability.rootLabel &&
    reference.leaseExpiresAt === capability.leaseExpiresAt
  );
}

/** Owns one opt-in, capture-scoped chooser. The editor owns the resulting references. */
export class ComposerFileReferenceOwner {
  enabled = false;
  literal = false;
  commandMode = false;
  phase: Phase = "idle";
  query = "";
  candidates: readonly { reference: FileReference; match: "path" | "name" | "spoken" }[] = [];
  selected: FileReference | undefined;
  capability: FileReferenceCapability | undefined;
  nextCursor: string | undefined;
  indexComplete = false;
  private generation = 0;
  private operation = 0;
  private review: Review | undefined;
  private consent: Pick<FileReferenceSource, "client" | "sessionKey" | "agentId"> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private committing = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readSource: () => FileReferenceSource,
    private readonly prepare = prepareFileReferenceDestination,
  ) {}

  get source() {
    return this.readSource();
  }

  bindComposer(props: ChatComposerProps, state: ChatComposerState) {
    this.rebind(() => readComposerFileReferenceSource(props, state));
  }

  /** A remounted presenter supplies fresh props and must obtain fresh consent. */
  rebind(readSource: () => FileReferenceSource) {
    this.enable(false);
    this.readSource = readSource;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get open() {
    return this.review !== undefined;
  }

  get supportsBinding() {
    return this.review?.destination?.namespace === FILE_REFERENCE_NAMESPACE;
  }

  get busy() {
    return this.phase === "preparing" || this.phase === "searching" || this.phase === "confirming";
  }

  get commandNumber() {
    return (this.review?.command ?? 0) + 1;
  }

  get commandCount() {
    return this.review?.commands.length ?? 0;
  }

  enable(value: boolean) {
    this.cancel();
    this.enabled = false;
    this.consent = undefined;
    if (value) {
      const source = this.readSource();
      this.enabled = source.connected && source.eligible;
      if (this.enabled) {
        this.consent = {
          client: source.client,
          sessionKey: source.sessionKey,
          agentId: source.agentId,
        };
      }
    }
    this.publish();
  }

  setLiteral(value: boolean) {
    this.literal = value;
    this.cancel();
  }

  setCommandMode(value: boolean) {
    this.commandMode = value;
    this.cancel();
  }

  sync(source = this.readSource()) {
    // The editor publishes its own input synchronously inside commit. Its receipt
    // owns that transition; ordinary edits are checked before and after it.
    if (this.committing) {
      return;
    }
    if (this.enabled && (!source.connected || !source.eligible)) {
      this.enable(false);
      this.phase = source.connected ? "stale" : "offline";
      this.publish();
      return;
    }
    if (
      this.consent &&
      (this.consent.client !== source.client ||
        this.consent.sessionKey !== source.sessionKey ||
        this.consent.agentId !== source.agentId)
    ) {
      this.enable(false);
      return;
    }
    if (this.review && !this.current(this.review, undefined, source)) {
      this.cancel(source.connected ? "stale" : "offline");
    }
  }

  capture() {
    this.sync();
    this.cancel();
    const generation = this.generation;
    const captured = this.readSource();
    const enabled = this.enabled;
    const literal = this.literal;
    const commandMode = this.commandMode;
    const captureId = crypto.randomUUID();
    if (!enabled) {
      return undefined;
    }
    return (receipt: DictationReferenceReceipt | undefined, final: boolean) => {
      if (
        !enabled ||
        !this.enabled ||
        generation !== this.generation ||
        !final ||
        !receipt ||
        !receipt.complete
      ) {
        return;
      }
      const source = this.readSource();
      if (
        source.client !== captured.client ||
        source.sessionKey !== captured.sessionKey ||
        source.agentId !== captured.agentId ||
        source.target !== captured.target ||
        source.target !== receipt.target ||
        receipt.previousValue !== captured.draft ||
        receipt.value !== source.draft ||
        receipt.value.slice(receipt.from, receipt.to) !== receipt.text ||
        !source.connected ||
        !source.eligible
      ) {
        return;
      }
      const plan = recognizeDictatedFileReferences(receipt.text, {
        locale: captured.locale,
        literal,
        commandMode,
      });
      const firstCommand = plan.commands[0];
      if (plan.status !== "ready" || !firstCommand) {
        return;
      }
      const review: Review = {
        generation,
        source,
        expectedText: receipt.value,
        expectedRevision: source.revision,
        context: {
          captureId,
          generation,
          transcriptRevision: 1,
          targetId: crypto.randomUUID(),
          draftRevision: source.revision,
        },
        commands: plan.commands.map((command) => ({
          query: command.query,
          kind: command.kind,
          start: receipt.from + command.start,
          end: receipt.from + command.end,
        })),
        command: 0,
        destination: null,
        snapshot: null,
      };
      this.review = review;
      this.phase = "preparing";
      this.publish();
      void this.prepare(receipt.target)
        .then((destination) => {
          if (!this.current(review)) {
            return;
          }
          review.destination = destination;
          review.snapshot = destination?.snapshot() ?? null;
          if (review.snapshot && review.snapshot.text !== review.expectedText) {
            this.cancel("stale");
            return;
          }
          if (
            review.snapshot?.references.some((reference) =>
              review.commands.some(
                (command) => command.start < reference.end && command.end > reference.start,
              ),
            )
          ) {
            this.cancel("stale");
            return;
          }
          this.query = firstCommand.query;
          void this.search();
        })
        .catch(() => {
          if (this.current(review)) {
            this.phase = "unsupported";
            this.publish();
          }
        });
    };
  }

  setQuery(query: string) {
    if (this.phase === "confirming" || this.phase === "outcome-unknown") {
      return;
    }
    this.operation += 1;
    this.query = query;
    this.candidates = [];
    this.selected = undefined;
    this.nextCursor = undefined;
    this.phase = "choosing";
    this.publish();
  }

  async search(more = false) {
    const review = this.review;
    const command = review?.commands[review.command];
    if (
      !review ||
      !command ||
      !this.current(review) ||
      this.phase === "confirming" ||
      this.phase === "outcome-unknown"
    ) {
      return;
    }
    if (command.kind === "current") {
      this.phase = "unsupported";
      this.publish();
      return;
    }
    if (
      !this.query.trim() ||
      new TextEncoder().encode(this.query).length > FILE_REFERENCE_MAX_QUERY_BYTES
    ) {
      this.fail("denied");
      return;
    }
    const operation = ++this.operation;
    const cursor = more ? this.nextCursor : undefined;
    this.phase = "searching";
    this.selected = undefined;
    this.candidates = [];
    this.publish();
    try {
      if (!this.capability) {
        const ready = await this.request(review, { action: "capabilities" });
        if (!this.current(review, operation)) {
          if (ready.status === "ready") {
            void this.request(review, {
              action: "release",
              leaseId: ready.capability.leaseId,
            }).catch(() => undefined);
          }
          return;
        }
        if (ready.status !== "ready") {
          this.fail(ready.status);
          return;
        }
        this.capability = ready.capability;
        clearTimeout(this.expiry);
        this.expiry = setTimeout(
          () => this.cancel("expired"),
          Math.max(0, ready.capability.leaseExpiresAt - Date.now()),
        );
      }
      const capability = this.capability;
      const result = await this.request(review, {
        action: "search",
        leaseId: capability.leaseId,
        query: this.query,
        ...(cursor ? { cursor } : {}),
      });
      if (!this.current(review, operation)) {
        return;
      }
      if (
        result.status !== "matches" ||
        !sameCapability(capability, result.capability) ||
        result.candidates.some(({ reference }) => !belongs(reference, capability))
      ) {
        this.fail(result.status);
        return;
      }
      this.candidates = result.candidates;
      this.nextCursor = result.nextCursor;
      this.indexComplete = result.indexComplete;
      this.phase = result.candidates.length ? "choosing" : "no-matches";
      this.publish();
    } catch {
      if (this.current(review, operation)) {
        this.fail("denied");
      }
    }
  }

  select(objectId: string) {
    if (this.busy || this.phase === "outcome-unknown") {
      return;
    }
    this.selected = this.candidates.find(
      ({ reference }) => reference.objectId === objectId,
    )?.reference;
    this.publish();
  }

  async confirm() {
    const review = this.review;
    const command = review?.commands[review.command];
    const selected = this.selected;
    const capability = this.capability;
    if (
      !review?.destination ||
      !command ||
      !review.snapshot ||
      !selected ||
      !capability ||
      this.busy ||
      this.phase === "outcome-unknown" ||
      !this.current(review)
    ) {
      return;
    }
    this.phase = "confirming";
    this.publish();
    let deliveryStarted = false;
    try {
      const result = await this.request(review, {
        action: "revalidate",
        leaseId: capability.leaseId,
        objectId: selected.objectId,
      });
      if (!this.current(review)) {
        return;
      }
      if (
        result.status !== "validated" ||
        !belongs(result.reference, capability) ||
        result.reference.objectId !== selected.objectId ||
        result.reference.relativePath !== selected.relativePath ||
        result.reference.displayLabel !== selected.displayLabel
      ) {
        this.fail(result.status);
        return;
      }
      const text = fileReferenceText(result.reference);
      const expectedText =
        review.expectedText.slice(0, command.start) + text + review.expectedText.slice(command.end);
      this.committing = true;
      deliveryStarted = true;
      let receipt: ReturnType<FileReferenceDestination["commit"]>;
      try {
        receipt = review.destination.commit({
          id: `${review.context.captureId}:${review.command}`,
          snapshot: review.snapshot,
          from: command.start,
          to: command.end,
          text,
          references: [{ start: 0, end: text.length, reference: result.reference }],
        });
      } finally {
        this.committing = false;
      }
      if (receipt.status !== "committed") {
        this.phase = receipt.status === "outcome-unknown" ? "outcome-unknown" : "stale";
        this.publish();
        return;
      }
      review.snapshot = review.destination.snapshot();
      if (review.snapshot.text !== expectedText || this.readSource().draft !== expectedText) {
        this.cancel("stale");
        return;
      }
      review.expectedText = review.snapshot.text;
      review.expectedRevision = this.readSource().revision;
      const delta = text.length - (command.end - command.start);
      for (const remaining of review.commands.slice(review.command + 1)) {
        remaining.start += delta;
        remaining.end += delta;
      }
      await this.release();
      if (!this.current(review)) {
        return;
      }
      review.command += 1;
      const nextCommand = review.commands[review.command];
      if (nextCommand) {
        this.query = nextCommand.query;
        this.phase = "choosing";
        await this.search();
      } else {
        this.review = undefined;
        this.phase = "committed";
        this.publish();
      }
    } catch {
      // Delivery exceptions cannot establish that no edit happened. Never retry or copy.
      if (this.review === review) {
        this.phase = deliveryStarted ? "outcome-unknown" : "denied";
        this.publish();
      }
    }
  }

  async copy(referenceText: boolean) {
    if (
      !this.selected ||
      !this.review ||
      this.busy ||
      this.phase === "outcome-unknown" ||
      !this.current(this.review)
    ) {
      return;
    }
    const review = this.review;
    try {
      await navigator.clipboard.writeText(
        referenceText ? fileReferenceText(this.selected) : this.selected.relativePath,
      );
      if (this.current(review)) {
        this.phase = "copied";
        this.publish();
      }
    } catch {
      if (this.current(review)) {
        this.phase = "copy-failed";
        this.publish();
      }
    }
  }

  cancel(phase: Phase = "idle") {
    void this.release();
    this.generation += 1;
    this.operation += 1;
    this.review = undefined;
    this.phase = phase;
    this.candidates = [];
    this.selected = undefined;
    this.nextCursor = undefined;
    this.publish();
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
  }

  private current(review: Review, operation?: number, source = this.readSource()) {
    return (
      this.review === review &&
      this.generation === review.generation &&
      (operation === undefined || operation === this.operation) &&
      this.enabled &&
      source.connected &&
      source.eligible &&
      source.client === review.source.client &&
      source.sessionKey === review.source.sessionKey &&
      source.agentId === review.source.agentId &&
      source.target === review.source.target &&
      source.draft === review.expectedText &&
      source.revision === review.expectedRevision
    );
  }

  private async request(review: Review, action: FileReferenceAction) {
    const response = await review.source.request({
      schemaVersion: 1,
      sessionKey: review.source.sessionKey,
      agentId: review.source.agentId,
      context: review.context,
      ...action,
    });
    if (!isFileReferenceResult(response)) {
      throw new Error("Unsupported file reference response");
    }
    return response;
  }

  private fail(status: string) {
    this.phase =
      status === "expired" || status === "stale" || status === "unsupported" ? status : "denied";
    this.publish();
  }

  private release(): Promise<unknown> {
    clearTimeout(this.expiry);
    const review = this.review;
    const capability = this.capability;
    this.capability = undefined;
    if (review && capability) {
      return this.request(review, { action: "release", leaseId: capability.leaseId }).catch(
        () => undefined,
      );
    }
    return Promise.resolve();
  }

  private publish() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
