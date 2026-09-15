// Raw command-hook snapshots are not reset-relative display history.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { boundedParsedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readHotSessionTranscriptSnapshot,
  readRestoredSessionTranscript,
} from "./session-cold-storage-read.js";
import {
  projectTranscriptNavigation,
  projectRawHookNavigationSql,
  projectTranscriptRawMessageEligibilitySql,
  projectTranscriptRawTypeSql,
} from "./session-model-context-projection.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptActiveEntries,
} from "./transcript-tree.js";

/** Count/classify in SQLite where compatible; decode exceptional rows only inside a fixed budget. */
export async function readSessionTranscriptHookMessages(
  scope: SessionTranscriptReadScope,
  limits: { maxMessages: number; maxBytes: number },
): Promise<{ messages: unknown[]; totalMessages?: number; truncated: boolean }> {
  return readRestoredSessionTranscript(scope, () => {
    const resolved = resolveSqliteTranscriptReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    return readHotSessionTranscriptSnapshot(database, resolved.sessionId, "events", () => {
      const db = getSessionKysely(database.db);
      const maxMessages = Math.max(0, Math.floor(limits.maxMessages));
      const maxBytes = Math.max(0, Math.floor(limits.maxBytes));
      const incomplete = () => ({ messages: [], truncated: true });
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const rows = db
        .selectFrom("transcript_events")
        .where("session_id", "=", resolved.sessionId)
        .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq));
      const readBoundedRow = (seq: number, bytes: number): unknown => {
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          rows
            .select("event_json")
            .where("seq", "=", seq)
            .where((eb) => eb(eb.fn<number>("octet_length", ["event_json"]), "<=", bytes)),
        );
        if (!row) {
          throw new Error("Raw hook row exceeded its pre-hydration budget");
        }
        return JSON.parse(row.event_json);
      };
      const compatible = new Map<
        number,
        { navigation: Record<string, unknown>; message?: unknown }
      >();
      let compatibilityBytes = 2;
      for (const row of iterateSqliteQuerySync(
        database.db,
        rows
          .select((eb) => ["seq", eb.fn<number>("octet_length", ["event_json"]).as("bytes")])
          .where((eb) => eb(eb.fn<number>("json_valid", ["event_json"]), "=", 0))
          .orderBy("seq", "desc"),
      )) {
        // Classification must not smuggle an oversized body past the payload cap.
        // If its bounded fallback cannot establish membership/topology, say unknown.
        if (compatible.size >= maxMessages || compatibilityBytes + row.bytes + 1 > maxBytes) {
          return incomplete();
        }
        const event = readBoundedRow(row.seq, maxBytes - compatibilityBytes - 1);
        compatibilityBytes += row.bytes + 1;
        const record = asOptionalRecord(event);
        compatible.set(row.seq, {
          navigation: projectTranscriptNavigation(event, { includeResetBoundary: true }),
          ...(record?.type === "message" && record.message ? { message: record.message } : {}),
        });
      }
      const compatibleLeaves = [...compatible]
        .filter(([, row]) => row.navigation.type === "leaf")
        .map(([seq]) => String(seq));
      const compatibleMessages = [...compatible]
        .filter(([, row]) => row.message !== undefined)
        .map(([seq]) => String(seq));
      const lastLeaf = executeSqliteQueryTakeFirstSync(
        database.db,
        rows
          .select("seq")
          .where((eb) =>
            eb.or([
              eb(projectTranscriptRawTypeSql(eb.ref("event_json")), "=", "leaf"),
              eb(eb.cast<string>("seq", "text"), "in", sqliteStringSet(compatibleLeaves)),
            ]),
          )
          .orderBy("seq", "desc")
          .limit(1),
      );
      let metadataComplete = true;
      let navigationBytes = 2;
      const navigationBudgetExceeded = new Error("Raw hook navigation budget exhausted");
      const retainNavigation = (value: unknown) => {
        const measured = boundedParsedJsonUtf8Bytes(value, maxBytes - navigationBytes - 1);
        if (!measured.complete) {
          throw navigationBudgetExceeded;
        }
        navigationBytes += measured.bytes + 1;
      };
      function* navigationRows(): Generator<Record<string, unknown> & { seq: number }> {
        const metadataRows = rows.select((eb) => [
          "seq",
          eb
            .case()
            .when(eb.fn<number>("json_valid", ["event_json"]), "=", 1)
            .then(
              eb.fn<number>("octet_length", [
                projectRawHookNavigationSql(eb.ref("event_json"), eb.ref("seq")),
              ]),
            )
            .else(eb.fn<number>("octet_length", ["event_json"]))
            .end()
            .as("bytes"),
        ]);
        const readNavigation = prepareSqliteQuerySync<number, { navigation: string }>(
          database.db,
          (parameter) =>
            rows
              .select((eb) =>
                projectRawHookNavigationSql(eb.ref("event_json"), eb.ref("seq")).as("navigation"),
              )
              .where(
                "seq",
                "=",
                parameter((seq) => seq),
              ),
        );
        for (const row of iterateSqliteQuerySync(database.db, metadataRows.orderBy("seq", "asc"))) {
          const fallback = compatible.get(row.seq);
          const candidateBytes = fallback
            ? boundedParsedJsonUtf8Bytes(
                { ...fallback.navigation, seq: row.seq },
                maxBytes - navigationBytes - 1,
              )
            : { bytes: row.bytes, complete: true };
          // Fallback bodies were already bounded before hydration; only their
          // retained navigation participates in this separate structural budget.
          if (!candidateBytes.complete || navigationBytes + candidateBytes.bytes + 1 > maxBytes) {
            metadataComplete = false;
            return;
          }
          const navigation =
            fallback?.navigation ??
            projectTranscriptNavigation(JSON.parse(readNavigation(row.seq).rows[0]!.navigation), {
              includeResetBoundary: true,
            });
          yield { ...navigation, seq: row.seq };
        }
      }
      let authoritativeSeqs: number[] | undefined;
      if (lastLeaf !== undefined) {
        // The message-count ceiling bounds delivered bodies, not history needed
        // to establish a branch. Budget the canonical retained structure instead:
        // nodes include their entry and identity/cursor/index bookkeeping; records
        // not retained as nodes are charged with their array index. No row-count
        // bump, current-index shortcut, or second tree construction is required.
        const entries: Array<Record<string, unknown> & { seq: number }> = [];
        let retainedAsNode = false;
        let hasAcceptedLeaf = false;
        const finalLeafSeq = lastLeaf.seq;
        function* captureNavigation() {
          for (const entry of navigationRows()) {
            retainedAsNode = false;
            entries.push(entry);
            yield entry;
            // Later non-leaf rows cannot retroactively accept a rejected control.
            if (entry.seq >= finalLeafSeq && !hasAcceptedLeaf) {
              return;
            }
            if (!retainedAsNode) {
              retainNavigation({ entry, index: entries.length - 1 });
            }
          }
        }
        try {
          const tree = scanSessionTranscriptTree(captureNavigation(), {
            beforeRetainNode: (node) => {
              retainNavigation(node);
              retainedAsNode = true;
              if (node.entry.type === "leaf" && node.leafId !== undefined) {
                hasAcceptedLeaf = true;
              }
            },
          });
          if (!metadataComplete) {
            return incomplete();
          }
          if (tree.hasLeafControl) {
            authoritativeSeqs = selectSessionTranscriptActiveEntries({
              entries,
              recordOf: (entry) => entry,
              tree,
            }).map((entry) => entry.seq);
          }
        } catch (error) {
          if (error === navigationBudgetExceeded) {
            return incomplete();
          }
          throw error;
        }
      }
      const source = db
        .selectFrom("transcript_events as event")
        .where("event.session_id", "=", resolved.sessionId)
        .where((eb) =>
          eb.or([
            eb(projectTranscriptRawMessageEligibilitySql(eb.ref("event.event_json")), "=", 1),
            eb(eb.cast<string>("event.seq", "text"), "in", sqliteStringSet(compatibleMessages)),
          ]),
        )
        .$if(fence !== undefined, (query) => query.where("event.seq", "<", fence!.beforeRawSeq))
        .$if(authoritativeSeqs !== undefined, (query) =>
          query.where((eb) =>
            eb(
              eb.cast<string>("event.seq", "text"),
              "in",
              sqliteStringSet(authoritativeSeqs!.map(String)),
            ),
          ),
        );
      const totalMessages =
        executeSqliteQueryTakeFirstSync(
          database.db,
          source.select((eb) => eb.fn.countAll<number>().as("count")),
        )?.count ?? 0;
      const metadataQuery = source.select((eb) => [
        "event.seq",
        eb.fn<number>("octet_length", ["event.event_json"]).as("bytes"),
      ]);
      let metadata: Array<{ seq: number; bytes: number }>;
      if (authoritativeSeqs !== undefined) {
        // The navigation graph is bounded above. Preserve its order, including
        // duplicate IDs whose current ancestors were stored after their descendants.
        const bySeq = new Map(
          executeSqliteQuerySync(database.db, metadataQuery).rows.map((row) => [row.seq, row]),
        );
        metadata = authoritativeSeqs
          .toReversed()
          .flatMap((seq) => {
            const row = bySeq.get(seq);
            return row ? [row] : [];
          })
          .slice(0, maxMessages);
      } else {
        metadata = executeSqliteQuerySync(
          database.db,
          metadataQuery.orderBy("event.seq", "desc").limit(maxMessages),
        ).rows;
      }
      const selected: number[] = [];
      let bytes = 2;
      for (const row of metadata) {
        if (bytes + row.bytes + 1 > maxBytes) {
          break;
        }
        selected.push(row.seq);
        bytes += row.bytes + 1;
      }
      const selectedSet = new Set(selected);
      // Discard unselected fallback bodies before hydrating ordinary selected rows.
      for (const seq of compatible.keys()) {
        if (!selectedSet.has(seq)) {
          compatible.delete(seq);
        }
      }
      const ordinary = selected.filter((seq) => !compatible.has(seq));
      const messagesBySeq = new Map<number, unknown>();
      if (ordinary.length > 0) {
        for (const row of executeSqliteQuerySync(
          database.db,
          rows.select(["seq", "event_json"]).where("seq", "in", ordinary),
        ).rows) {
          const event = asOptionalRecord(JSON.parse(row.event_json));
          messagesBySeq.set(row.seq, event?.message);
        }
      }
      const messages = selected
        .toReversed()
        .map((seq) => compatible.get(seq)?.message ?? messagesBySeq.get(seq));
      return { messages, totalMessages, truncated: totalMessages > messages.length };
    });
  });
}
