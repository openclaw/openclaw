import path from "node:path";
import {
  hasVerifiedRequesterCompletionHandoff,
  MAX_DELEGATION_LINEAGE_DEPTH,
} from "../agents/requester-tool-policy.js";
import type { SessionCapabilityLookup } from "../agents/subagents/spawn/subagent-session-store.js";
import { evaluateGatewayToolCallerReceiptAdmission } from "../agents/tools/gateway-caller-context.js";
import type { GatewayToolCallerReceiptAdmission } from "../agents/tools/gateway-caller-receipt.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { projectSessionEntryCapabilityFacts } from "../config/sessions/session-entry-capability-facts.js";
import type {
  SessionEntryCurrentFacts,
  SessionEntryCurrentSource,
} from "../config/sessions/session-entry-current.types.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";

type CompletionGrantLineageParams = {
  cfg: OpenClawConfig;
  preparedSessionCapabilityStore?: SessionCapabilityLookup;
  context: Pick<
    McpLoopbackRequestContext,
    | "sessionKey"
    | "runtimePolicySessionKey"
    | "sessionId"
    | "modelProvider"
    | "modelId"
    | "inputProvenance"
    | "trustedInternalHandoff"
  >;
};

/**
 * Whether a completion grant's requester lineage still verifies. Grants without a
 * handoff carry no lineage and are always current. The child entry can be removed or
 * re-parented while a tool call awaits preparation, hooks or approvals, so the tool
 * list, the dispatch authorization and the tool's source-effect guard all ask this.
 */
function isCompletionGrantLineageCurrent(params: CompletionGrantLineageParams): boolean {
  const { context } = params;
  return (
    !context.trustedInternalHandoff ||
    hasVerifiedRequesterCompletionHandoff({
      config: params.cfg,
      sessionKey: context.runtimePolicySessionKey?.trim() || context.sessionKey,
      sessionId: context.sessionId,
      modelProvider: context.modelProvider,
      modelId: context.modelId,
      inputProvenance: context.inputProvenance,
      trustedInternalHandoff: context.trustedInternalHandoff,
      preparedSessionCapabilityStore: params.preparedSessionCapabilityStore,
    })
  );
}

type LineageRead = { kind: "key" | "id"; key: string };

class CompletionLineageReadRequired extends Error {
  constructor(readonly query: LineageRead) {
    super("Completion lineage requires current worker facts");
  }
}

/** Register lineage predicates separately from the MCP grant's lifecycle assertion. */
export function createCompletionGrantLineageAdmission(params: CompletionGrantLineageParams) {
  if (!params.context.trustedInternalHandoff) {
    return { isCurrent: () => true, admission: undefined };
  }
  const binding = getSessionActorStorageBinding({});
  const env = binding
    ? { OPENCLAW_STATE_DIR: path.resolve(binding.path, "../../../..") }
    : undefined;
  const owners = new Map<string, ReturnType<typeof captureSessionActorStorageOwner>>();
  const authority = { assertCurrent() {}, authorize() {} };
  const admission: GatewayToolCallerReceiptAdmission = {
    async prepare() {
      const { withSessionStoreReaderInWorker } =
        await import("../config/sessions/session-entry-read-runtime.js");
      const reads: Array<{
        query: LineageRead;
        source: SessionEntryCurrentSource;
        assertSourceCurrent(): void;
      }> = [];
      const entries = new Map<string, SessionEntryCurrentFacts | undefined>();
      const publishedReads = new Map<string, () => SessionEntryCurrentFacts | undefined>();
      const readKey = (query: LineageRead) => JSON.stringify([query.kind, query.key]);
      const get = (query: LineageRead) => {
        const key = readKey(query);
        const published = publishedReads.get(key);
        if (published) {
          return published();
        }
        if (!entries.has(key)) {
          throw new CompletionLineageReadRequired(query);
        }
        return entries.get(key);
      };
      const store: SessionCapabilityLookup = {
        authoritative: true,
        get: (key) => get({ kind: "key", key }),
        getById: (key) => get({ kind: "id", key }),
      };
      const current = () =>
        isCompletionGrantLineageCurrent({
          ...params,
          preparedSessionCapabilityStore: store,
        });
      const maximumReads = 2 * MAX_DELEGATION_LINEAGE_DEPTH;
      for (;;) {
        let query: LineageRead;
        try {
          if (!current()) {
            throw new Error("CLI completion tool grant no longer matches its requester policy");
          }
          break;
        } catch (error) {
          if (!(error instanceof CompletionLineageReadRequired)) {
            throw error;
          }
          query = error.query;
        }
        if (reads.length + publishedReads.size >= maximumReads) {
          throw new Error("Completion lineage changed during worker preparation");
        }
        const agentId = parseAgentSessionKey(query.key)?.agentId;
        if (!agentId) {
          throw new Error("Completion lineage requires an agent-qualified source");
        }
        if (isIncognitoSessionKey(query.key)) {
          if (!owners.has(agentId)) {
            owners.set(
              agentId,
              captureSessionActorStorageOwner(
                { agentId, sessionKey: query.key, sessionActor: binding },
                authority,
              ),
            );
          }
          const selected = owners.get(agentId);
          publishedReads.set(readKey(query), () => {
            selected?.binding?.actor.assertReadable();
            const owner = selected?.owner;
            if (!owner || !selected) {
              return undefined;
            }
            const row =
              query.kind === "id"
                ? owner.readSessionById(query.key, selected.authority)
                : undefined;
            const entry = owner.readStorage(
              row?.sessionKey ?? query.key,
              { type: "session.entry.read", input: { projection: "list" } },
              selected.authority,
            );
            return entry && (query.kind === "key" || entry.sessionId === query.key)
              ? projectSessionEntryCapabilityFacts(entry)
              : undefined;
          });
          continue;
        }
        const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId,
          env,
        });
        await withSessionStoreReaderInWorker(
          { agentId, storePath, env },
          async (owner) => {
            const result = await owner.reader.readExactEntries({
              ...(query.kind === "key"
                ? { sessionKeys: [query.key] }
                : { selection: { kind: "session-id", sessionId: query.key } as const }),
              projection: "sharing",
              env: owner.database.env,
              continuation: owner.continuation,
            });
            owner.assertCurrent();
            const identity = readDatabasePathIdentitySync(owner.database.path);
            if (!identity.key.startsWith("file:")) {
              throw new Error("Completion lineage source is unavailable");
            }
            const selected = { ...owner.selectedStore };
            const source: SessionEntryCurrentSource = Object.freeze({
              agentId: owner.database.agentId,
              path: owner.database.path,
              databaseIdentity: identity.key.slice("file:".length),
              databaseBirthtime: identity.birthtime,
              sessionKey: query.key,
              projection: "capability",
              ...(query.kind === "id" ? { sessionIdLookup: query.key } : {}),
            });
            const assertSourceCurrent = () => {
              assertExistingDatabaseIdentity(source.path, identity.key, identity.birthtime);
              if (
                captureSessionStoreReadCandidate(selected.path).physicalPath !==
                selected.physicalPath
              ) {
                throw new Error("Completion lineage source changed");
              }
            };
            assertSourceCurrent();
            entries.set(readKey(query), result.entries[0]?.entry);
            reads.push({ query, source, assertSourceCurrent });
          },
          { backing: true, dataOnly: true },
        );
      }
      const isCurrent = () => {
        try {
          for (const read of reads) {
            read.assertSourceCurrent();
          }
          return current();
        } catch {
          return false;
        }
      };
      return {
        current: {
          sources: reads.map((read) => read.source),
          assertCurrent(values) {
            if (values.length !== reads.length) {
              throw new Error("Completion lineage admission has an incomplete source cohort");
            }
            reads.forEach((read, index) => entries.set(readKey(read.query), values[index]));
            if (!isCurrent()) {
              throw new Error("CLI completion tool grant no longer matches its requester policy");
            }
          },
        },
        isCurrent,
      };
    },
  };
  return {
    admission,
    isCurrent: () =>
      evaluateGatewayToolCallerReceiptAdmission(admission, () =>
        isCompletionGrantLineageCurrent(params),
      ),
  };
}

/** Rejects a tool list, built or cached, whose completion grant outlived its lineage. */
export function assertCompletionGrantLineage(params: CompletionGrantLineageParams): void {
  if (!isCompletionGrantLineageCurrent(params)) {
    throw new Error("CLI completion tool grant no longer matches its requester policy");
  }
}
