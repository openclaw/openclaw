import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { setEnvironmentData, threadId } from "node:worker_threads";
import {
  changedAdmissionEntries,
  changedAdmissionWriteScopes as changedWriteScopes,
} from "./sqlite-database-admission-delta.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  SQLITE_DATABASE_GENERATION_LENGTH,
  SqliteDatabaseGenerationSlot,
  advanceSqliteDatabaseGeneration,
  createSqliteDatabaseAdmissionCursor,
  isSqliteDatabaseAdmissionFactCurrent,
  isSqliteDatabaseAdmissionRetired,
  readSqliteDatabaseAdmissionIdentity,
  readSqliteDatabaseGeneration,
  retainSqliteDatabaseWriteScope,
  snapshotSqliteDatabaseWriteScopes,
  type Admission,
  type AdmissionFact,
  type AdmissionPublications,
  type AdmissionSnapshot,
  type PublishedAdmission,
  type SqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissions,
  type SqliteDatabaseDescriptorCustody,
} from "./sqlite-database-admission-record.js";
import {
  adoptSqliteDescriptor,
  createSqliteDescriptorCustody,
  isSqliteDescriptorCustodyOpen,
  isSqliteDescriptorCustodyClosed,
  retireSqliteDescriptorCustody,
} from "./sqlite-descriptor-custody.js";
import { normalizeDatabasePath, readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

export class SqliteDatabaseAdmissionRegistry {
  readonly records = new Map<string, Admission>();
  private exchangeCursor = createSqliteDatabaseAdmissionCursor();
  private readonly locations = new Map<string, string>();
  private readonly published = new Map<string, PublishedAdmission>();
  private readonly scopeSweeps = new WeakMap<Admission, number>();
  readonly descriptors = new Map<string, SqliteDatabaseDescriptorCustody>();
  private revision = 0;
  private retainProcessFacts = true;

  useConnectionScopedFacts(): void {
    this.retainProcessFacts = false;
  }

  changeReferences(record: Admission, change: 1 | -1): boolean {
    let references = record.references.get(threadId);
    if (!references) {
      references = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
      record.references.set(threadId, references);
    }
    const count = Atomics.add(new Int32Array(references), 0, change) + change;
    if (count !== (change === 1 ? 1 : 0)) {
      return false;
    }
    if (change === -1) {
      this.retireUnreferenced(record);
    }
    this.publish(record);
    return true;
  }

  private retireUnreferenced(record: Admission): void {
    if (
      threadId !== 0 ||
      isSqliteDatabaseAdmissionRetired(record) ||
      [...record.references.values()].some(
        (references) => Atomics.load(new Int32Array(references), 0) > 0,
      )
    ) {
      return;
    }
    for (const [name, fact] of record.facts) {
      if (
        !this.retainProcessFacts ||
        fact.lifetime !== "process" ||
        !isSqliteDatabaseAdmissionFactCurrent(record, fact)
      ) {
        record.facts.delete(name);
      }
    }
    const custody = this.descriptors.get(record.identity);
    if (custody) {
      custody.facts = record.facts;
    }
    // Row facts and receipts retire; shared-owner physical facts can stay with descriptor custody.
    Atomics.compareExchange(
      new Int32Array(record.generation),
      SqliteDatabaseGenerationSlot.retired,
      0,
      2,
    );
    record.writeScopes.clear();
  }

  releaseWorker(owner: number): void {
    const changedRecords: AdmissionPublications = new Map();
    for (const record of this.records.values()) {
      const references = owner > 0 ? record.references.get(owner) : undefined;
      if (!references) {
        continue;
      }
      // A terminated worker cannot run the transaction's diagnostic finally.
      Atomics.compareExchange(record.writerDiagnostic, 1, owner + 1, 0);
      // Zero permits a live worker to reopen; negative cells cannot be revived by old snapshots.
      Atomics.store(new Int32Array(references), 0, -1);
      this.retireUnreferenced(record);
      changedRecords.set(record, undefined);
    }
    if (changedRecords.size > 0) {
      this.publish(changedRecords);
    }
  }

  observeLocation(location: string, identity: string | undefined): void {
    const pathname = normalizeDatabasePath(path.resolve(location));
    if (identity === undefined) {
      this.locations.delete(pathname);
    } else {
      this.locations.set(pathname, identity);
    }
  }

  forLocation(location: string): Admission | undefined {
    return this.forPathname(normalizeDatabasePath(path.resolve(location)));
  }

  prepareLocation(location: string): () => Admission | undefined {
    const pathname = normalizeDatabasePath(path.resolve(location));
    return () => this.forPathname(pathname);
  }

  private forPathname(pathname: string): Admission | undefined {
    const identity = this.locations.get(pathname);
    const record = identity === undefined ? undefined : this.records.get(identity);
    return record && !isSqliteDatabaseAdmissionRetired(record) ? record : undefined;
  }

  forget(identity: string): void {
    this.records.delete(identity);
    this.published.delete(identity);
    for (const [location, observed] of this.locations) {
      if (observed === identity) {
        this.locations.delete(location);
      }
    }
  }

  getDescriptorCustody(identity: string): SqliteDatabaseDescriptorCustody | undefined {
    const custody = this.descriptors.get(identity);
    if (!custody) {
      return undefined;
    }
    if (isSqliteDescriptorCustodyClosed(custody.descriptorCustody)) {
      this.descriptors.delete(identity);
      if (this.records.get(identity)?.descriptorCustody.id === custody.descriptorCustody.id) {
        this.forget(identity);
      }
      return undefined;
    }
    if (!isSqliteDescriptorCustodyOpen(custody.descriptorCustody)) {
      throw new Error("SQLite descriptor custody retirement is pending or uncertain");
    }
    return custody;
  }

  /** Physical custody survives cancellation without publishing native authority. */
  retainDescriptorCustody(
    location: string,
    descriptor: number,
    opened: BigIntStats,
  ): SqliteDatabaseDescriptorCustody {
    const identity = readSqliteDatabaseAdmissionIdentity(opened);
    const existing = this.getDescriptorCustody(identity);
    if (existing) {
      adoptSqliteDescriptor(existing.descriptorCustody, descriptor);
      return existing;
    }
    const custody = {
      location,
      descriptor,
      descriptorCustody: createSqliteDescriptorCustody(descriptor),
      file: opened,
      facts: new Map<string, AdmissionFact>(),
    };
    this.descriptors.set(identity, custody);
    return custody;
  }

  retainDescriptor(location: string, descriptor: number, opened: BigIntStats): Admission {
    const retained = this.retainDescriptorCustody(location, descriptor, opened);
    const record: Admission = {
      identity: readSqliteDatabaseAdmissionIdentity(opened),
      physicalIdentity: {
        key: `file:${opened.dev}:${opened.ino}`,
        birthtime: readDatabaseIdentityBirthtime(opened),
      },
      location,
      descriptor: retained.descriptor,
      descriptorOwner: 0,
      descriptorCustody: retained.descriptorCustody,
      generationId: randomUUID(),
      generation: new SharedArrayBuffer(
        Int32Array.BYTES_PER_ELEMENT * SQLITE_DATABASE_GENERATION_LENGTH,
      ),
      writerDiagnostic: new Int32Array(new SharedArrayBuffer(125 * Int32Array.BYTES_PER_ELEMENT)),
      writeScopes: new Map(),
      writeScopeRevision: 0,
      references: new Map(),
      facts: new Map(
        [...retained.facts]
          .filter(([, fact]) => Atomics.load(new Int32Array(fact.current), 0) === 1)
          .map(([name, fact]) => [name, { ...fact, revision: 0 }]),
      ),
    };
    this.records.set(record.identity, record);
    // The first descriptor and custody object remain canonical across generations.
    retained.location = location;
    retained.facts = new Map();
    this.observeLocation(location, record.identity);
    this.publish(record);
    return record;
  }

  /** Only the joined lifecycle owner may release a retained descriptor. */
  retireDescriptor(identity: string, options: { requireSoleDescriptor?: boolean }): boolean {
    const record = this.records.get(identity);
    const retained = this.descriptors.get(identity);
    const custody = retained?.descriptorCustody ?? record?.descriptorCustody;
    if (!custody) {
      return false;
    }
    const expected = retained
      ? {
          key: `file:${retained.file.dev}:${retained.file.ino}`,
          birthtime: readDatabaseIdentityBirthtime(retained.file),
        }
      : record!.physicalIdentity;
    let retired = false;
    try {
      retired = retireSqliteDescriptorCustody(custody, expected, options);
    } finally {
      if (!isSqliteDescriptorCustodyOpen(custody) && record) {
        Atomics.store(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.retired, 1);
      }
    }
    if (!retired) {
      return false;
    }
    if (this.descriptors.get(identity)?.descriptorCustody.id === custody.id) {
      this.descriptors.delete(identity);
    }
    if (this.records.get(identity)?.descriptorCustody.id === custody.id) {
      this.forget(identity);
    }
    this.publish();
    return true;
  }

  publish(selected?: Admission | AdmissionPublications, scopeKeys?: readonly string[]): void {
    const isBatch = selected instanceof Map;
    if (selected && !isBatch && this.records.get(selected.identity) !== selected) {
      return;
    }
    // Another isolate can retire shared custody. Reclaim it at publication, not on every request.
    for (const current of this.records.values()) {
      if (isSqliteDatabaseAdmissionRetired(current)) {
        const retained = this.descriptors.get(current.identity);
        if (
          isSqliteDescriptorCustodyClosed(current.descriptorCustody) &&
          retained?.descriptorCustody.id === current.descriptorCustody.id
        ) {
          this.descriptors.delete(current.identity);
        }
        this.forget(current.identity);
        continue;
      }
      if (selected && selected !== current && !(isBatch && selected.has(current))) {
        continue;
      }
      let changed = selected === current || isBatch;
      for (const [owner, references] of current.references) {
        if (Atomics.load(new Int32Array(references), 0) < 0) {
          current.references.delete(owner);
          changed = true;
        }
      }
      const previous = this.published.get(current.identity);
      const scopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      const keys = previous && selected ? (isBatch ? selected.get(current) : scopeKeys) : undefined;
      const sweep = keys === undefined && this.scopeSweeps.get(current) !== scopeRevision;
      const writeScopes = snapshotSqliteDatabaseWriteScopes(
        current.writeScopes,
        previous?.writeScopes,
        keys ?? (sweep ? undefined : []),
      );
      // Keyed publications can acknowledge a revision without sweeping remote retirements.
      if (sweep) {
        this.scopeSweeps.set(current, scopeRevision);
      }
      changed ||= writeScopes !== previous?.writeScopes;
      if (!changed) {
        continue;
      }
      if (threadId === 0) {
        current.writeScopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      }
      const { writeScopes: _ownedScopes, ...fields } = current;
      const metadata = {
        ...fields,
        facts: new Map(current.facts),
        references: new Map(current.references),
        hostRevision:
          threadId === 0
            ? readSqliteDatabaseGeneration(current, "hostRevision")
            : current.hostRevision,
      };
      // Clone the immutable buckets directly; receivers install cells into their owned Map.
      const snapshot: AdmissionSnapshot = {
        ...metadata,
        writeScopes: writeScopes.filter((bucket) => bucket.size > 0),
      };
      this.published.set(current.identity, { metadata, writeScopes, snapshot });
    }
    this.revision++;
    setEnvironmentData(
      SQLITE_DATABASE_ADMISSIONS_KEY,
      [...this.published.values()].map((record) => record.snapshot),
    );
  }

  capture(
    cursor?: SqliteDatabaseAdmissionCursor,
    scope?: { location?: string; admissions?: readonly Pick<Admission, "identity">[] },
  ): SqliteDatabaseAdmissions {
    const identities = scope
      ? new Set([
          ...(scope.admissions?.map((record) => record.identity) ?? []),
          ...(scope.location === undefined
            ? []
            : [this.forLocation(scope.location)?.identity].filter((value) => value !== undefined)),
        ])
      : undefined;
    if (!identities && !cursor) {
      this.publish();
    }
    if (!identities && cursor?.revision === this.revision) {
      return [];
    }
    const records = identities
      ? [...identities].flatMap((identity) => {
          const record = this.published.get(identity);
          return record && !isSqliteDatabaseAdmissionRetired(record.snapshot) ? [record] : [];
        })
      : [...this.published.values()];
    if (!cursor) {
      return records.map((record) => record.snapshot);
    }
    // A scoped reply cannot acknowledge snapshots belonging to other databases.
    if (!identities) {
      cursor.revision = this.revision;
    }
    return records.flatMap((record) => {
      const previous = cursor.records.get(record.metadata.generation);
      if (previous === record) {
        return [];
      }
      cursor.records.set(record.metadata.generation, record);
      // One cursor follows one ordered receiver. Shared cells already carry revocation;
      // resend only replaced entries, not every session's buffer after each publication.
      return [
        previous
          ? {
              ...record.metadata,
              facts: changedAdmissionEntries(record.metadata.facts, previous.metadata.facts),
              writeScopes: [changedWriteScopes(record.writeScopes, previous.writeScopes)],
              references: changedAdmissionEntries(
                record.metadata.references,
                previous.metadata.references,
              ),
            }
          : record.snapshot,
      ];
    });
  }

  captureExchange(
    scope?: { location?: string; admissions?: readonly Pick<Admission, "identity">[] },
    target?: string | Admission,
  ) {
    return target && typeof target !== "string" && isSqliteDatabaseAdmissionRetired(target)
      ? [{ ...target, facts: new Map(), writeScopes: [], references: new Map() }]
      : this.capture(this.exchangeCursor, scope);
  }

  resetExchangeCursor(): void {
    this.exchangeCursor = createSqliteDatabaseAdmissionCursor();
  }

  install(admissions: SqliteDatabaseAdmissions): boolean {
    const changedRecords: AdmissionPublications = new Map();
    for (const incoming of admissions) {
      let record = this.records.get(incoming.identity);
      if (incoming.descriptorOwner !== 0 || isSqliteDatabaseAdmissionRetired(incoming)) {
        if (record && isSqliteDatabaseAdmissionRetired(record)) {
          changedRecords.set(record, undefined);
        }
        continue;
      }
      const custody = this.descriptors.get(incoming.identity);
      if (
        threadId === 0 &&
        custody &&
        custody.descriptorCustody.id !== incoming.descriptorCustody.id
      ) {
        continue;
      }
      let changed = false;
      if (record && isSqliteDatabaseAdmissionRetired(record)) {
        record = undefined;
      }
      if (!record) {
        record = {
          ...incoming,
          facts: new Map(incoming.facts),
          writeScopes: new Map(),
          references: new Map(incoming.references),
          hostRevision: undefined,
        };
        this.records.set(incoming.identity, record);
        this.observeLocation(incoming.location, incoming.identity);
        changed = true;
      } else if (record.generationId !== incoming.generationId) {
        // Only the host creates a generation; unrelated revocation cells cannot certify its facts.
        continue;
      }
      if (!record.cleanCloseRefusal && incoming.cleanCloseRefusal) {
        record.cleanCloseRefusal = incoming.cleanCloseRefusal;
        changed = true;
      }
      for (const [key, fact] of incoming.facts) {
        if (
          isSqliteDatabaseAdmissionFactCurrent(incoming, fact) &&
          record.facts.get(key)?.publication !== fact.publication
        ) {
          record.facts.set(key, fact);
          changed = true;
        }
      }
      const scopeKeys = changedRecords.get(record) ?? [];
      for (const bucket of incoming.writeScopes) {
        for (const [key, revision] of bucket) {
          if (Atomics.load(revision.state, 1) !== 0) {
            continue;
          }
          // The host selects one shared incarnation for concurrent discoveries of the same key.
          const previous = record.writeScopes.get(key);
          if (
            previous?.identity === revision.identity ||
            (threadId === 0 && previous && Atomics.load(previous.state, 1) === 0)
          ) {
            continue;
          }
          if (threadId === 0) {
            const previousRevision = advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
            // The keyed publication covers this addition, never an unseen peer's retirement.
            if (this.scopeSweeps.get(record) === previousRevision) {
              this.scopeSweeps.set(record, (previousRevision + 1) | 0);
            }
          }
          retainSqliteDatabaseWriteScope(record, key, revision);
          scopeKeys.push(key);
          changed = true;
        }
      }
      const writeScopeRevision = readSqliteDatabaseGeneration(record, "writeScopeRevision");
      if (threadId === 0 || incoming.writeScopeRevision === writeScopeRevision) {
        changed ||= record.writeScopeRevision !== writeScopeRevision;
        record.writeScopeRevision = writeScopeRevision;
      }
      for (const [owner, references] of incoming.references) {
        if (!record.references.has(owner) && Atomics.load(new Int32Array(references), 0) >= 0) {
          record.references.set(owner, references);
          changed = true;
        }
      }
      if (
        threadId !== 0 &&
        incoming.hostRevision !== undefined &&
        incoming.hostRevision !== record.hostRevision &&
        incoming.hostRevision === readSqliteDatabaseGeneration(record, "hostRevision")
      ) {
        record.hostRevision = incoming.hostRevision;
        changed = true;
      }
      // Only the host has every borrower's reference cell; worker snapshots can omit later peers.
      this.retireUnreferenced(record);
      if (changed || isSqliteDatabaseAdmissionRetired(record)) {
        // Reuse the admitted snapshot; only imported cells need keyed publication.
        changedRecords.set(record, scopeKeys.length > 0 ? scopeKeys : undefined);
      }
    }
    if (changedRecords.size > 0) {
      this.publish(changedRecords);
    }
    return changedRecords.size > 0;
  }
}
