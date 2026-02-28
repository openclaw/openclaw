/**
 * ULS Hub — Core Service Module
 *
 * Runs as part of the Gateway process (or standalone for testing).
 * Provides the internal API for encoding, projecting, storing,
 * and retrieving cross-agent shared memory records.
 */

import crypto from "node:crypto";
import { canWriteAtScope, validateSchemaVersion } from "./policy.js";
import { projectPublic, sanitizeObject } from "./sanitize.js";
import { UlsStore, hashInput } from "./store.js";
import type {
  UlsConfig,
  UlsConsensusUpdate,
  UlsContradictionMeta,
  UlsHubApi,
  UlsRecord,
  UlsRecordModality,
  UlsRetrieveQuery,
  UlsRetrieveResult,
  UlsScope,
} from "./types.js";
import { ULS_SCHEMA_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Hub singleton management
// ---------------------------------------------------------------------------

let hubInstance: UlsHub | undefined;

export function getUlsHub(): UlsHub | undefined {
  return hubInstance;
}

export function createUlsHub(config: UlsConfig): UlsHub {
  if (hubInstance) {
    return hubInstance;
  }
  hubInstance = new UlsHub(config);
  return hubInstance;
}

export async function destroyUlsHub(): Promise<void> {
  if (hubInstance) {
    await hubInstance.close();
    hubInstance = undefined;
  }
}

// ---------------------------------------------------------------------------
// Hub implementation
// ---------------------------------------------------------------------------

export class UlsHub implements UlsHubApi {
  private _store: UlsStore;
  private config: UlsConfig;

  constructor(config: UlsConfig) {
    this.config = config;
    this._store = new UlsStore(config.storagePath || undefined);
  }

  /**
   * Encode a raw state observation u_t into a ULS record.
   * Applies sanitization + projection to produce p_public.
   */
  async encode(ut: Record<string, unknown>, agentId: string): Promise<UlsRecord> {
    const modality: UlsRecordModality = (ut.modality as UlsRecordModality) ?? "system_event";
    const scope: UlsScope = (ut.scope as UlsScope) ?? "self";
    const tags: string[] = Array.isArray(ut.tags) ? (ut.tags as string[]) : [];

    // Sanitize the raw state
    const { cleaned: sanitizedUt, flags: utFlags } = sanitizeObject(ut);

    // Project to public
    const { pPublic, riskFlags: projFlags } = projectPublic(
      sanitizedUt as Record<string, unknown>,
      modality,
    );

    const riskFlags = [...new Set([...utFlags, ...projFlags])];

    const record: UlsRecord = {
      schemaVersion: ULS_SCHEMA_VERSION,
      recordId: crypto.randomUUID(),
      agentId,
      timestamp: Date.now(),
      modality,
      ut: sanitizedUt as Record<string, unknown>,
      pPublic,
      tags,
      riskFlags,
      scope,
      acl: buildDefaultAcl(ut),
      provenance: {
        sourceTool: ut.sourceTool as string | undefined,
        sourceChannel: ut.sourceChannel as string | undefined,
        inputHash: hashInput(JSON.stringify(ut)),
      },
    };

    return record;
  }

  /**
   * Extract the shareable public projection from a record.
   */
  project(record: UlsRecord): Record<string, unknown> {
    return record.pPublic;
  }

  /**
   * Store a record after policy validation.
   */
  async store(record: UlsRecord): Promise<void> {
    // Validate schema version
    const versionCheck = validateSchemaVersion(record);
    if (!versionCheck.allowed) {
      throw new Error(`ULS store rejected: ${versionCheck.reason}`);
    }

    // Validate scope authorization
    const scopeCheck = canWriteAtScope(record.agentId, record.scope, this.config);
    if (!scopeCheck.allowed) {
      throw new Error(`ULS store rejected: ${scopeCheck.reason}`);
    }

    await this._store.store(record);
  }

  /**
   * Retrieve records matching the query, enforcing ACL/scope server-side.
   */
  async retrieve(query: UlsRetrieveQuery): Promise<UlsRetrieveResult> {
    return this._store.retrieve(query, this.config);
  }

  /**
   * Consensus update stub (v0 — logs intent, no-op).
   */
  async consensusUpdate(update: UlsConsensusUpdate): Promise<void> {
    // v0 stub: store as system_event
    const record = await this.encode(
      {
        modality: "system_event",
        eventType: "consensus_vote",
        proposalId: update.proposalId,
        vote: update.vote,
        rationale: update.rationale,
        scope: "global",
      },
      update.agentId,
    );
    record.scope = "global";
    await this._store.store(record);
  }

  /**
   * Store a contradiction detection event.
   */
  async contradictionUpdate(
    agentId: string,
    meta: UlsContradictionMeta,
    ut: Record<string, unknown>,
  ): Promise<void> {
    const record = await this.encode(
      {
        ...ut,
        modality: "contradiction",
        contradictionType: meta.contradictionType,
        tensionScore: meta.tensionScore,
        parties: meta.parties,
        synthesisHint: meta.synthesisHint,
        scope: "team",
        tags: ["contradiction", meta.contradictionType],
      },
      agentId,
    );
    // Allow team scope for contradictions even if not explicitly configured
    record.scope = "team";
    await this._store.store(record);
  }

  /**
   * Graceful shutdown.
   */
  async close(): Promise<void> {
    await this._store.close();
  }

  // Expose for testing
  getStore(): UlsStore {
    return this._store;
  }

  getConfig(): UlsConfig {
    return this.config;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultAcl(ut: Record<string, unknown>): { allow?: string[]; deny?: string[] } {
  const acl: { allow?: string[]; deny?: string[] } = {};
  if (Array.isArray(ut.aclAllow)) {
    acl.allow = ut.aclAllow as string[];
  }
  if (Array.isArray(ut.aclDeny)) {
    acl.deny = ut.aclDeny as string[];
  }
  return acl;
}
