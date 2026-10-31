import { createMemo, createSignal, onCleanup } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatUiError } from "../lib/format-error.ts";
import type {
  SessionCapability,
  SessionRowObservation,
} from "../lib/sessions/session-capability.ts";

type DetailScope = { sessions: Pick<SessionCapability, "observeRow" | "describe"> };
type DetailRow = Pick<GatewaySessionRow, "key" | "sessionId" | "rowMode" | "agentId">;
type DetailBinding = {
  matches: () => boolean;
  dispose: () => void;
  row: () => GatewaySessionRow | null;
};
type DetailRead = { binding: DetailBinding; result: Promise<string | undefined> };

/** The expanded view holds a descriptor; the session capability owns its row facts. */
export function createSessionDetails<Scope extends DetailScope>(options: {
  captureScope: () => Scope | null;
  isCurrent: (scope: Scope) => boolean;
  row: () => DetailRow | undefined;
  agentId: (row: DetailRow, scope: Scope) => string;
}) {
  const [receipt, setReceipt] = createSignal<DetailRead | null>(null);
  const readKey: () => DetailBinding | null = createMemo(() => receipt()?.binding ?? null);
  const read: () => void = createMemo(() => {
    const admitted = receipt();
    return admitted
      ? admitted.result.then((error) => {
          if (error) {
            throw new Error(error);
          }
        })
      : Promise.resolve();
  });
  const [rowRevision, setRowRevision] = createSignal(0);
  const rowChanged = () => setRowRevision((value) => value + 1);
  let loading = false;
  let activeBinding: DetailBinding | undefined;

  const release = () => {
    activeBinding?.dispose();
    activeBinding = undefined;
    loading = false;
  };
  const reset = () => {
    release();
    setReceipt(null);
    rowChanged();
  };
  // This primitive releases its observation synchronously, including during held reads.
  onCleanup(release);

  function synchronize() {
    if (activeBinding?.matches()) {
      return;
    }
    reset();
    const row = options.row();
    const scope = row && options.captureScope();
    if (!row || !scope) {
      return;
    }
    const { key, sessionId } = row;
    const agentId = options.agentId(row, scope);
    const retired = Promise.withResolvers<undefined>();
    // Registration may notify before the observation handle is returned.
    let observation: SessionRowObservation | null = null;
    const binding = {
      matches: () => {
        const selected = options.row();
        return (
          options.isCurrent(scope) &&
          observation?.isCurrent() !== false &&
          selected?.key === key &&
          selected.sessionId === sessionId
        );
      },
      dispose: () => {
        retired.resolve(undefined);
        observation?.dispose();
      },
      row: () =>
        observation?.row && observation.row.sessionId === sessionId ? observation.row : null,
    };
    const current = () => activeBinding === binding && binding.matches();
    const refresh = () => {
      if (loading || !current()) {
        return;
      }
      loading = true;
      const request = async () => {
        try {
          if (observation?.isCurrent()) {
            const reconcile = observation.captureReconcile();
            const { session } = await scope.sessions.describe({ key, agentId });
            if (current()) {
              reconcile(session ?? undefined);
            }
          }
        } catch (failure) {
          if (current()) {
            return formatUiError(failure);
          }
        } finally {
          if (current()) {
            loading = false;
          }
        }
        return undefined;
      };
      // The owner admits once; the presentation observes it and consumes late failures.
      setReceipt({ binding, result: Promise.race([request(), retired.promise]) });
    };
    activeBinding = binding;
    observation = scope.sessions.observeRow(
      { key, agentId },
      () => {
        if (current()) {
          rowChanged();
        }
      },
      { onInvalidate: refresh },
    );
    rowChanged();
    if (row.rowMode) {
      refresh();
    }
  }
  return {
    read,
    readKey,
    reset,
    retry(this: void) {
      reset();
      synchronize();
    },
    synchronize,
    row(this: void) {
      rowRevision();
      return activeBinding?.matches() ? activeBinding.row() : null;
    },
  };
}
