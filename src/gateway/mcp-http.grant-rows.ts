// Grant-owned MCP loopback rows.
// A client grant owns the node execution its rows drive for the whole run: the
// schema rows live with the grant, not with the short schema cache, so a run
// never re-mints the execution the node still holds, and the execution closes
// with the run's real outcome when the grant is revoked.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import type { McpLoopbackClientGrantCloseReason } from "./mcp-grant-store.js";

// Node closes ride on best-effort node invokes. A successor computer row waits
// this long for a retired predecessor's close to reach the node, and shutdown
// waits the same budget for closes already in flight.
const NODE_CLOSE_BUDGET_MS = 5_000;

export type ScopedToolsCleanup = (reason: string) => Promise<void>;

/** Collects one row's tool cleanups. Registration is a construction-time contract. */
export function createScopedToolsCleanupOwner(): {
  register: (cleanup: ScopedToolsCleanup) => void;
  dispose: ScopedToolsCleanup;
} {
  const cleanups: ScopedToolsCleanup[] = [];
  let pending: Promise<void> | undefined;
  return {
    register: (cleanup) => {
      if (pending) {
        throw new Error("mcp loopback tool cleanup registered after its row was retired");
      }
      cleanups.push(cleanup);
    },
    dispose: (reason) => {
      pending ??= (async () => {
        const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup(reason)));
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, failures.map(formatErrorMessage).join("; "));
        }
      })();
      return pending;
    },
  };
}

type GrantRow = {
  // Drains the node resources the row's tool instances registered (a computer
  // execution opens on the first screenshot). Idempotent.
  dispose?: ScopedToolsCleanup;
};

export type GrantResources<Row extends GrantRow> = {
  computerExecutionId: string;
  // Bumped when the authority behind the token is replaced: a row built against
  // the previous authority may still answer its own request but is never published.
  generation: number;
  rows: Map<string, { cfg: OpenClawConfig; row: Row }>;
  // Cleanups of rows that left `rows` (replaced authority, cap, config change,
  // stale session facts); they close with the grant because their sessions may
  // have bound targets.
  retiredCleanups: Set<ScopedToolsCleanup>;
  // The run's settlement once the grant ended; a row still discovering nodes
  // at that point closes with it instead of a made-up reason.
  closeReason?: McpLoopbackClientGrantCloseReason;
};

/** Grant rows and the node closes they owe, bounded by one global row cap. */
export class McpLoopbackGrantRows<Row extends GrantRow> {
  #grants = new Map<string, GrantResources<Row>>();
  #rowCount = 0;
  #pendingDisposals = new Set<Promise<void>>();
  readonly #maxRows: number;

  constructor(maxRows: number) {
    this.#maxRows = maxRows;
  }

  get hasPendingDisposals(): boolean {
    return this.#pendingDisposals.size > 0;
  }

  acquire(grantToken: string): GrantResources<Row> {
    let grant = this.#grants.get(grantToken);
    if (!grant) {
      grant = {
        computerExecutionId: randomUUID(),
        generation: 0,
        rows: new Map(),
        retiredCleanups: new Set(),
      };
      this.#grants.set(grantToken, grant);
    }
    return grant;
  }

  lookup(grant: GrantResources<Row>, cacheKey: string, cfg: OpenClawConfig): Row | undefined {
    const pinned = grant.rows.get(cacheKey);
    return pinned?.cfg === cfg ? pinned.row : undefined;
  }

  /** Pins a freshly built row unless its grant ended or changed authority meanwhile. */
  publish(
    grantToken: string,
    grant: GrantResources<Row>,
    generation: number,
    cacheKey: string,
    cfg: OpenClawConfig,
    row: Row,
  ): void {
    if (this.#grants.get(grantToken) !== grant) {
      // The run ended, or the token was transferred, while this row was still
      // discovering nodes; nothing may keep it. A transferred token's request is
      // refused right after resolve, so its row never binds a target to close.
      if (row.dispose) {
        this.#retire(row.dispose, grant.closeReason ?? "cancel", grant.computerExecutionId);
      }
      return;
    }
    if (grant.generation !== generation) {
      // The authority behind the token changed meanwhile. This request may still
      // answer with the row it observed, but later requests must not.
      if (row.dispose) {
        grant.retiredCleanups.add(row.dispose);
      }
      return;
    }
    const previous = grant.rows.get(cacheKey);
    if (previous) {
      // A config reload or stale session facts replace the row under the same
      // key; the old row's session may have bound a target, so its cleanup
      // stays with the grant.
      if (previous.row.dispose) {
        grant.retiredCleanups.add(previous.row.dispose);
      }
    } else {
      this.#rowCount += 1;
    }
    grant.rows.set(cacheKey, { cfg, row });
    while (this.#rowCount > this.#maxRows && this.#dropOneRow()) {
      // Bounded by the rows that exist; each iteration removes one.
    }
  }

  /** Waits for in-flight node closes, bounded by the budget and the caller's signal. */
  async settleDisposals(signal?: AbortSignal): Promise<void> {
    const pending = [...this.#pendingDisposals];
    if (pending.length === 0 || signal?.aborted) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const budget = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), NODE_CLOSE_BUDGET_MS);
      // The caller stops waiting on abort; the closes themselves keep running.
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([
        Promise.all(pending).then(() => "settled" as const),
        budget,
      ]);
      if (outcome === "timeout") {
        logWarn(
          `mcp loopback: computer execution close still running after ${NODE_CLOSE_BUDGET_MS}ms; continuing`,
        );
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * The authority behind a live token was replaced: its rows captured the old
   * authority and must go, but the node execution the run drives stays open.
   */
  evict(token: string): boolean {
    const grant = this.#grants.get(token);
    if (!grant) {
      return false;
    }
    grant.generation += 1;
    return this.#unpinRows(grant);
  }

  /** The run moved onto a successor token; its execution and cleanups move with it. */
  transfer(token: string, successorToken: string): void {
    const source = this.#grants.get(token);
    if (!source) {
      return;
    }
    this.#grants.delete(token);
    this.#unpinRows(source);
    const successor = this.#grants.get(successorToken);
    if (successor) {
      // A warm process keeps its execution across turns; the fresh turn's grant
      // never built rows of its own, so only its bookkeeping joins the successor.
      for (const dispose of source.retiredCleanups) {
        successor.retiredCleanups.add(dispose);
      }
      return;
    }
    this.#grants.set(successorToken, source);
  }

  /** The run the token served ended; close the node execution with its real outcome. */
  revoke(token: string, closeReason: McpLoopbackClientGrantCloseReason): boolean {
    const grant = this.#grants.get(token);
    if (!grant) {
      return false;
    }
    this.#grants.delete(token);
    grant.closeReason = closeReason;
    const released = grant.rows.size > 0 || grant.retiredCleanups.size > 0;
    this.#retireGrant(grant, closeReason);
    return released;
  }

  /** Cancels every grant still tracked and waits, bounded, for the closes. */
  async clear(): Promise<void> {
    for (const grant of this.#grants.values()) {
      grant.closeReason = "cancel";
      this.#retireGrant(grant, "cancel");
    }
    this.#grants.clear();
    await this.settleDisposals();
  }

  #retire(
    dispose: ScopedToolsCleanup,
    reason: McpLoopbackClientGrantCloseReason,
    executionId: string,
  ): void {
    const disposal = dispose(reason).catch((error: unknown) => {
      logWarn(
        `mcp loopback: closing computer execution ${executionId} failed (${reason}): ` +
          `${formatErrorMessage(error)}; if the node reports COMPUTER_HOST_BUSY, run ` +
          `\`openclaw nodes invoke --node <node> --command computer.act --params ` +
          `'{"action":"__close_execution","executionId":"${executionId}","reason":"unstick"}'\``,
      );
    });
    this.#pendingDisposals.add(disposal);
    void disposal.finally(() => {
      this.#pendingDisposals.delete(disposal);
    });
  }

  /** Drops the grant's rows without touching the execution they share. */
  #unpinRows(grant: GrantResources<Row>): boolean {
    const hadRows = grant.rows.size > 0;
    for (const { row } of grant.rows.values()) {
      if (row.dispose) {
        grant.retiredCleanups.add(row.dispose);
      }
    }
    this.#rowCount -= grant.rows.size;
    grant.rows.clear();
    return hadRows;
  }

  #retireGrant(grant: GrantResources<Row>, reason: McpLoopbackClientGrantCloseReason): void {
    this.#unpinRows(grant);
    for (const dispose of grant.retiredCleanups) {
      this.#retire(dispose, reason, grant.computerExecutionId);
    }
    grant.retiredCleanups.clear();
  }

  #dropOneRow(): boolean {
    for (const grant of this.#grants.values()) {
      for (const [key, { row }] of grant.rows) {
        grant.rows.delete(key);
        this.#rowCount -= 1;
        if (row.dispose) {
          grant.retiredCleanups.add(row.dispose);
        }
        return true;
      }
    }
    return false;
  }
}
