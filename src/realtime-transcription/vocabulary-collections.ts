import { randomUUID } from "node:crypto";
import type {
  PluginStateKeyedStore,
  PluginStateObservation,
} from "../plugin-state/plugin-state-store.types.js";
import { parseVocabularyImport, validateVocabularyDraft } from "./vocabulary-terms.js";
import {
  VOCABULARY_LIMITS,
  VocabularyError,
  type AuthorizedVocabularyCollection,
  type VocabularyAuditEvent,
  type VocabularyAuthority,
  type VocabularyCollection,
  type VocabularyCollectionDraft,
  type VocabularyCollectionRef,
  type VocabularyGrant,
  type VocabularyOperation,
} from "./vocabulary-types.js";

type ActiveCollection = VocabularyCollection & { deleted: false };
export type VocabularyCollectionView = Omit<ActiveCollection, "audit">;
type CollectionStore = Pick<
  PluginStateKeyedStore<VocabularyCollection, 2>,
  "observe" | "compareAndApply" | "entriesInKeyRange"
>;
type CollectionAccess = { grant: VocabularyGrant; store: CollectionStore };

/** A failed reply never authorizes replay of an already attempted write. */
export class VocabularyCollectionWriteError extends VocabularyError {
  constructor(readonly outcome: "committed" | "unknown") {
    super(outcome === "unknown" ? "outcome-unknown" : "unavailable");
  }
}

function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new VocabularyError("invalid-input");
  }
  return value;
}

function captureRef(ref: VocabularyCollectionRef): VocabularyCollectionRef {
  return Object.freeze({
    scopeId: identifier(ref.scopeId),
    collectionId: identifier(ref.collectionId),
  });
}

function collectionKey(ref: VocabularyCollectionRef): string {
  return `${ref.scopeId}:${ref.collectionId}`;
}

function publicView(collection: ActiveCollection): VocabularyCollectionView {
  const { audit: _audit, ...view } = collection;
  return Object.freeze(view);
}

/**
 * Proposal over the existing action-bound worker store, not a membership implementation.
 * The opener must use a dedicated retained vocabulary namespace and bind grant.assertCurrent
 * through the V2 store's final write admission. No TTL or eviction may remove tombstones.
 */
export class VocabularyCollections {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly options: {
      authority?: VocabularyAuthority;
      openStore(grant: VocabularyGrant): CollectionStore;
      now?: () => number;
      id?: () => string;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  private check(grant: VocabularyGrant): void {
    try {
      if (!Number.isFinite(grant.expiresAt) || this.now() >= grant.expiresAt) {
        throw new Error();
      }
      grant.assertCurrent();
    } catch {
      throw new VocabularyError("unavailable");
    }
  }

  private async refresh(grant: VocabularyGrant): Promise<void> {
    this.check(grant);
    try {
      await grant.revalidate();
    } catch {
      throw new VocabularyError("unavailable");
    }
    this.check(grant);
  }

  private async access(
    ref: { scopeId: string; collectionId?: string },
    operation: VocabularyOperation,
    requireRead = false,
  ): Promise<CollectionAccess> {
    if (!this.options.authority) {
      throw new VocabularyError("unavailable");
    }
    const grants: VocabularyGrant[] = [];
    try {
      for (const required of requireRead ? [operation, "read" as const] : [operation]) {
        grants.push(await this.options.authority.authorize({ ...ref, operation: required }));
      }
    } catch {
      throw new VocabularyError("unavailable");
    }
    for (const granted of grants) {
      await this.refresh(granted);
    }
    const actorId = grants[0]?.actorId;
    if (
      typeof actorId !== "string" ||
      !actorId ||
      actorId.length > 128 ||
      grants.some((grant) => grant.actorId !== actorId)
    ) {
      throw new VocabularyError("unavailable");
    }
    const grant: VocabularyGrant = Object.freeze({
      actorId,
      expiresAt: Math.min(...grants.map((entry) => entry.expiresAt)),
      assertCurrent: () => {
        for (const entry of grants) {
          this.check(entry);
        }
      },
      revalidate: async () => {
        for (const entry of grants) {
          await this.refresh(entry);
        }
        for (const entry of grants) {
          this.check(entry);
        }
      },
      onInvalidated: (listener: () => void) => {
        const disposers: Array<() => void> = [];
        try {
          for (const entry of grants) {
            disposers.push(entry.onInvalidated(listener));
          }
        } catch {
          for (const dispose of disposers) {
            dispose();
          }
          throw new VocabularyError("unavailable");
        }
        return () => {
          for (const dispose of disposers) {
            dispose();
          }
        };
      },
    });
    try {
      grant.assertCurrent();
      return { grant, store: this.options.openStore(grant) };
    } catch {
      throw new VocabularyError("unavailable");
    }
  }

  private async observe(
    ref: VocabularyCollectionRef,
    access: CollectionAccess,
  ): Promise<PluginStateObservation<VocabularyCollection>> {
    this.check(access.grant);
    let observation: PluginStateObservation<VocabularyCollection>;
    try {
      observation = await access.store.observe(collectionKey(ref));
    } catch {
      throw new VocabularyError("unavailable");
    }
    await this.refresh(access.grant);
    return observation;
  }

  private record(
    ref: VocabularyCollectionRef,
    row: VocabularyCollection | undefined,
  ): VocabularyCollection {
    if (!row || row.scopeId !== ref.scopeId || row.collectionId !== ref.collectionId) {
      throw new VocabularyError("unavailable");
    }
    if (row.schemaVersion !== 1) {
      throw new VocabularyError("unsupported-version");
    }
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new VocabularyError("invalid-input");
    }
    if (
      !Number.isFinite(row.updatedAt) ||
      !Array.isArray(row.audit) ||
      row.audit.length > VOCABULARY_LIMITS.auditEvents
    ) {
      throw new VocabularyError("invalid-input");
    }
    const audit = row.audit.map((event) => {
      if (
        !event ||
        typeof event.actorId !== "string" ||
        !event.actorId ||
        event.actorId.length > 128 ||
        !["create", "replace", "import", "delete"].includes(event.operation) ||
        !Number.isSafeInteger(event.revision) ||
        event.revision < 1 ||
        event.revision > row.revision ||
        !Number.isFinite(event.at) ||
        !Number.isSafeInteger(event.termCount) ||
        event.termCount < 0 ||
        event.termCount > VOCABULARY_LIMITS.collectionTerms
      ) {
        throw new VocabularyError("invalid-input");
      }
      return Object.freeze({
        actorId: event.actorId,
        operation: event.operation,
        revision: event.revision,
        at: event.at,
        termCount: event.termCount,
      });
    });
    const common = {
      ...ref,
      schemaVersion: 1 as const,
      revision: row.revision,
      updatedAt: row.updatedAt,
      audit: Object.freeze(audit),
    };
    if (typeof row.deleted !== "boolean") {
      throw new VocabularyError("invalid-input");
    }
    if (row.deleted) {
      return Object.freeze({ ...common, deleted: true });
    }
    // Decoded persistent values cross the versioned boundary here; future formats stay intact.
    const draft = validateVocabularyDraft({
      schemaVersion: row.schemaVersion,
      label: row.label,
      terms: row.terms,
    });
    return Object.freeze({ ...common, ...draft, deleted: false });
  }

  private active(
    ref: VocabularyCollectionRef,
    row: VocabularyCollection | undefined,
  ): ActiveCollection {
    const record = this.record(ref, row);
    if (record.deleted) {
      throw new VocabularyError("unavailable");
    }
    return record;
  }

  private assertCommittedCurrent(grant: VocabularyGrant): void {
    try {
      this.check(grant);
    } catch {
      throw new VocabularyCollectionWriteError("committed");
    }
  }

  private event(
    grant: VocabularyGrant,
    operation: VocabularyAuditEvent["operation"],
    revision: number,
    termCount: number,
    at: number,
  ): VocabularyAuditEvent {
    return Object.freeze({ actorId: grant.actorId, operation, revision, at, termCount });
  }

  private async commit(
    ref: VocabularyCollectionRef,
    access: CollectionAccess,
    comparison: string,
    value: VocabularyCollection,
  ): Promise<void> {
    await this.refresh(access.grant);
    let result: Awaited<ReturnType<CollectionStore["compareAndApply"]>>;
    try {
      result = await access.store.compareAndApply(collectionKey(ref), comparison, {
        operation: "update",
        action: "set",
        value,
      });
    } catch {
      throw new VocabularyCollectionWriteError("unknown");
    }
    if (result.status === "conflict") {
      await this.refresh(access.grant);
      // Do not return the store's current row: it can contain a deleted or inaccessible revision.
      throw new VocabularyError("revision-conflict");
    }
    try {
      await this.refresh(access.grant);
    } catch {
      throw new VocabularyCollectionWriteError("committed");
    }
  }

  async create(scopeId: string, input: unknown): Promise<VocabularyCollectionView> {
    if (!this.options.authority) {
      throw new VocabularyError("unavailable");
    }
    const scope = identifier(scopeId);
    const draft = validateVocabularyDraft(input);
    const access = await this.access({ scopeId: scope }, "manage", true);
    const ref = captureRef({ scopeId: scope, collectionId: this.id() });
    const observed = await this.observe(ref, access);
    if (observed.value) {
      throw new VocabularyError("unavailable");
    }
    const at = this.now();
    const value: ActiveCollection = Object.freeze({
      ...ref,
      ...draft,
      revision: 1,
      updatedAt: at,
      deleted: false,
      audit: Object.freeze([this.event(access.grant, "create", 1, draft.terms.length, at)]),
    });
    await this.commit(ref, access, observed.comparison, value);
    this.assertCommittedCurrent(access.grant);
    return publicView(value);
  }

  async readAuthorized(
    reference: VocabularyCollectionRef,
  ): Promise<AuthorizedVocabularyCollection> {
    const ref = captureRef(reference);
    const access = await this.access(ref, "read");
    const row = this.active(ref, (await this.observe(ref, access)).value);
    this.check(access.grant);
    // Snapshot consumers need terms and lineage, never administrative actor history.
    return Object.freeze({
      collection: Object.freeze({ ...row, audit: Object.freeze([]) }),
      grant: access.grant,
    });
  }

  async read(ref: VocabularyCollectionRef): Promise<VocabularyCollectionView> {
    const result = await this.readAuthorized(ref);
    this.check(result.grant);
    return publicView(result.collection);
  }

  private async mutate(
    reference: VocabularyCollectionRef,
    expectedRevision: number,
    operation: "replace" | "import" | "delete",
    prepare?: () => VocabularyCollectionDraft,
  ): Promise<{ collection: VocabularyCollection; grant: VocabularyGrant }> {
    const ref = captureRef(reference);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new VocabularyError("invalid-input");
    }
    const access = await this.access(ref, operation === "delete" ? "manage" : "edit", true);
    const observed = await this.observe(ref, access);
    const old = this.active(ref, observed.value);
    if (old.revision !== expectedRevision) {
      throw new VocabularyError("revision-conflict");
    }
    if (old.revision === Number.MAX_SAFE_INTEGER) {
      throw new VocabularyError("limit-exceeded");
    }
    const draft = prepare?.();
    const revision = old.revision + 1;
    const at = this.now();
    const audit = Object.freeze(
      [
        ...old.audit,
        this.event(access.grant, operation, revision, draft?.terms.length ?? 0, at),
      ].slice(-VOCABULARY_LIMITS.auditEvents),
    );
    const base = { ...ref, schemaVersion: 1 as const, revision, updatedAt: at, audit };
    const value: VocabularyCollection = draft
      ? Object.freeze({ ...base, ...draft, deleted: false })
      : Object.freeze({ ...base, deleted: true });
    await this.commit(ref, access, observed.comparison, value);
    return { collection: value, grant: access.grant };
  }

  async replace(ref: VocabularyCollectionRef, expectedRevision: number, input: unknown) {
    if (!this.options.authority) {
      throw new VocabularyError("unavailable");
    }
    const draft = validateVocabularyDraft(input);
    const { collection: value, grant } = await this.mutate(
      ref,
      expectedRevision,
      "replace",
      () => draft,
    );
    if (value.deleted) {
      throw new VocabularyError("unavailable");
    }
    this.assertCommittedCurrent(grant);
    return publicView(value);
  }

  async import(ref: VocabularyCollectionRef, expectedRevision: number, text: string) {
    const { collection: value, grant } = await this.mutate(ref, expectedRevision, "import", () =>
      parseVocabularyImport(text),
    );
    if (value.deleted) {
      throw new VocabularyError("unavailable");
    }
    this.assertCommittedCurrent(grant);
    return publicView(value);
  }

  async delete(ref: VocabularyCollectionRef, expectedRevision: number) {
    const { collection: value, grant } = await this.mutate(ref, expectedRevision, "delete");
    this.assertCommittedCurrent(grant);
    return Object.freeze({
      scopeId: value.scopeId,
      collectionId: value.collectionId,
      revision: value.revision,
      deleted: true,
    });
  }

  async export(reference: VocabularyCollectionRef): Promise<string> {
    const ref = captureRef(reference);
    const access = await this.access(ref, "export", true);
    const row = this.active(ref, (await this.observe(ref, access)).value);
    const text = JSON.stringify({
      schemaVersion: row.schemaVersion,
      label: row.label,
      terms: row.terms,
    });
    this.check(access.grant);
    return text;
  }

  async audit(reference: VocabularyCollectionRef): Promise<readonly VocabularyAuditEvent[]> {
    const ref = captureRef(reference);
    const access = await this.access(ref, "manage", true);
    const row = this.record(ref, (await this.observe(ref, access)).value);
    this.check(access.grant);
    return row.audit;
  }

  /** An absent collection ID requires scope-wide read authorization, not mere identity. */
  async list(scopeId: string, afterCollectionId?: string) {
    const scope = identifier(scopeId);
    const cursor = afterCollectionId === undefined ? "" : `${identifier(afterCollectionId)}!`;
    const access = await this.access({ scopeId: scope }, "read");
    this.check(access.grant);
    let entries: Awaited<ReturnType<CollectionStore["entriesInKeyRange"]>>;
    try {
      entries = await access.store.entriesInKeyRange({
        keyStartInclusive: `${scope}:${cursor}`,
        keyEndExclusive: `${scope};`,
        limit: 32,
      });
    } catch {
      throw new VocabularyError("unavailable");
    }
    await this.refresh(access.grant);
    const records = entries.map(({ key, value }) => {
      if (!key.startsWith(`${scope}:`)) {
        throw new VocabularyError("unavailable");
      }
      const ref = captureRef({ scopeId: scope, collectionId: key.slice(scope.length + 1) });
      return this.record(ref, value);
    });
    const collections = records.flatMap((row) => {
      if (row.deleted) {
        return [];
      }
      return [
        Object.freeze({
          scopeId: scope,
          collectionId: row.collectionId,
          revision: row.revision,
          label: row.label,
          updatedAt: row.updatedAt,
          termCount: row.terms.length,
        }),
      ];
    });
    this.check(access.grant);
    return Object.freeze({
      collections: Object.freeze(collections),
      nextCollectionId: records.length === 32 ? records.at(-1)?.collectionId : undefined,
    });
  }
}
