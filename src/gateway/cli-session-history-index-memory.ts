import {
  orderCliHistoryRows,
  createCliHistoryRow,
  DEDUPE_TIMESTAMP_WINDOW_MS,
  mergeCliHistoryRow,
  type CliHistoryIndex,
  type CliHistoryMergeStore,
  type HistoryMatch,
  type HistoryRow,
  type HistoryTextMatch,
} from "./cli-session-history-index-policy.js";
import {
  decodeIndexedHistoryText,
  noteImportedCliCoverage,
  selectCoveredCliAggregateIds,
  toLocalCoverageUsers,
} from "./cli-session-history-index.coverage.js";
import {
  cliAssistantAggregateOwnsCanonicalAttachments,
  createCliAssistantCoverage,
  isCliAssistantAggregateMessage,
  isNativeToolResultMessage,
} from "./cli-session-history.merge-aggregates.js";

function addToGroup(groups: Map<string, HistoryRow[]>, key: string, row: HistoryRow): void {
  const group = groups.get(key);
  if (group) {
    group.push(row);
  } else {
    groups.set(key, [row]);
  }
}

/** Request-owned display projection; the session actor remains the transcript owner. */
export class MemoryCliSessionHistoryIndex implements CliHistoryIndex {
  private readonly messages = new Map<number, HistoryRow>();
  private readonly imports: HistoryRow[] = [];
  private order: HistoryRow[] = [];
  private readonly messageOrdinals = new Map<string, number>();
  private readonly coverage = createCliAssistantCoverage();
  private readonly aggregateIds: number[] = [];
  private readonly coverageSegments: Array<{ import_id: number; turn: number }> = [];
  private readonly nativeToolResultImports = new Set<number>();
  private nextLocal = 0;
  count = 0;

  appendLocal(messages: readonly { message: unknown; seq: number }[]): void {
    for (const { message, seq } of messages) {
      const id = seq - 1;
      this.nextLocal = Math.max(this.nextLocal, id + 1);
      if (!this.messages.has(id)) {
        const row = createCliHistoryRow(message, id, seq);
        this.messages.set(id, row);
        // Native text cannot replace an attachment-owning canonical row.
        if (
          isCliAssistantAggregateMessage(message, row.role ?? undefined) &&
          !cliAssistantAggregateOwnsCanonicalAttachments(message)
        ) {
          this.aggregateIds.push(id);
        }
      }
    }
  }

  appendImported(message: unknown): void {
    if (isNativeToolResultMessage(message)) {
      this.nativeToolResultImports.add(this.imports.length);
    }
    this.imports.push(createCliHistoryRow(message, this.imports.length));
  }

  finish(): void {
    const external = new Map<string, HistoryRow>();
    const images = new Map<string, HistoryRow[]>();
    const textGroups = new Map<string, HistoryRow[]>();
    const floors = new Map<string, number>();
    const key = (role: string | null, text: string) => JSON.stringify([role ?? "", text]);
    const registerExternal = (row: HistoryRow) => {
      if (row.external_key && (external.get(row.external_key)?.id ?? -1) < row.id) {
        external.set(row.external_key, row);
      }
    };
    this.order = [...this.messages.values()].toSorted((a, b) => a.id - b.id);
    for (const row of this.order) {
      registerExternal(row);
      if (row.image_key) {
        addToGroup(images, row.image_key, row);
      }
      if (row.text && row.role) {
        addToGroup(textGroups, key(row.role, row.text), row);
      }
    }
    // Identity matches reserve their canonical row before weaker text matches run.
    for (const row of this.imports) {
      const match = row.external_key ? external.get(row.external_key) : undefined;
      if (match) {
        match.consumed = 1;
      }
    }
    const textMatchers = (withIdentity: boolean) => {
      const create = (time: "any" | "window" | "missing") => (params: HistoryTextMatch) => {
        const candidates = textGroups.get(key(params.role, params.text)) ?? [];
        let start = 0;
        let end = candidates.length;
        while (start < end) {
          const middle = (start + end) >>> 1;
          if (candidates[middle]!.id < params.floor) {
            start = middle + 1;
          } else {
            end = middle;
          }
        }
        for (let index = start; index < candidates.length; index++) {
          const row = candidates[index]!;
          if (row.consumed || (withIdentity && row.external_key !== null)) {
            continue;
          }
          if (time === "missing" && row.timestamp !== null) {
            continue;
          }
          if (
            time === "window" &&
            (row.timestamp === null ||
              Math.abs(row.timestamp - (params.timestamp ?? 0)) > DEDUPE_TIMESTAMP_WINDOW_MS)
          ) {
            continue;
          }
          return row;
        }
        return undefined;
      };
      return { any: create("any"), window: create("window"), missing: create("missing") };
    };
    const hasAggregates = this.aggregateIds.length > 0;
    if (hasAggregates) {
      this.coverage.setLocalUsers(
        toLocalCoverageUsers(
          this.order.filter((row) => row.role === "user" && !row.consumed && row.text !== null),
        ),
      );
    }
    const noteCoverage = (
      imported: Omit<HistoryRow, "payload">,
      match?: HistoryMatch,
      byIdentity = false,
    ) => {
      const turn = noteImportedCliCoverage(this.coverage, imported, {
        match,
        byIdentity,
        toolResult: this.nativeToolResultImports.has(imported.id),
      });
      if (turn !== undefined) {
        this.coverageSegments.push({ import_id: imported.id, turn });
      }
    };
    const store: CliHistoryMergeStore = {
      matchExternal: (identity) => external.get(identity),
      matchImage: (identity) => images.get(identity)?.find((row) => !row.consumed),
      matchers: { withIdentity: textMatchers(true), withoutIdentity: textMatchers(false) },
      minimumOrder: (role, text) => floors.get(key(role, text)) ?? 0,
      advanceOrderFloor: ({ role, text, minimumOrder }) => {
        const identity = key(role, text);
        floors.set(identity, Math.max(floors.get(identity) ?? 0, minimumOrder));
      },
      consume: (match) => {
        const row = this.messages.get(match.id)!;
        Object.assign(row, match, { consumed: 1 });
        registerExternal(row);
      },
      onMatch: hasAggregates ? noteCoverage : undefined,
    };
    let expanded = false;
    for (const imported of this.imports) {
      if (!mergeCliHistoryRow(imported, store)) {
        if (hasAggregates) {
          noteCoverage(imported);
        }
        const row = {
          ...imported,
          id: this.nextLocal++,
          payload: null,
          import_ref: imported.id,
          consumed: 1,
        };
        this.messages.set(row.id, row);
        this.order.push(row);
        registerExternal(row);
        expanded = true;
      }
    }
    this.coverage.release();
    if (hasAggregates) {
      const readTexts =
        (rows: (id: number) => HistoryRow | undefined) => (ids: readonly number[]) =>
          new Map(
            ids.flatMap((id) => {
              const text = decodeIndexedHistoryText(rows(id)?.text ?? null);
              return text ? [[id, text] as const] : [];
            }),
          );
      const dropped = selectCoveredCliAggregateIds({
        userIds: this.order
          .filter((row) => row.local_seq !== null && row.role === "user")
          .map((row) => row.id),
        aggregateIds: this.aggregateIds,
        segments: this.coverageSegments,
        readAggregateTexts: readTexts((id) => this.messages.get(id)),
        readSegmentTexts: readTexts((id) => this.imports[id]),
      });
      if (dropped.size > 0) {
        this.order = this.order.filter((row) => !dropped.has(row.id));
      }
    }
    if (expanded) {
      this.order = orderCliHistoryRows(this.order);
    }
    this.order.forEach((row, ordinal) => {
      row.ordinal = ordinal;
      if (row.message_id && !this.messageOrdinals.has(row.message_id)) {
        this.messageOrdinals.set(row.message_id, ordinal);
      }
    });
    this.count = this.order.length;
  }

  get importedCount(): number {
    return this.imports.length;
  }

  rows(start: number, end: number) {
    return this.order
      .slice(Math.max(0, start), Math.max(0, end))
      .map(({ id, local_seq, metadata, ordinal, bytes }) => ({
        id,
        local_seq,
        metadata,
        ordinal,
        bytes,
      }));
  }

  message(id: number): unknown {
    const reference = this.messages.get(id)?.import_ref;
    const payload = reference == null ? undefined : this.imports[reference]?.payload;
    return payload ? JSON.parse(payload) : undefined;
  }

  localOrdinal(seq: number): number | undefined {
    const row = this.messages.get(seq - 1);
    return row?.local_seq === seq ? (row.ordinal ?? undefined) : undefined;
  }

  ordinal(messageId: string): number | undefined {
    return this.messageOrdinals.get(JSON.stringify(messageId));
  }

  close(): void {
    this.coverage.release();
    this.messages.clear();
    this.imports.length = 0;
    this.order.length = 0;
    this.messageOrdinals.clear();
  }
}
