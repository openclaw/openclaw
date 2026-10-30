import { action, affects, createMemo, createOptimistic, refresh } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { canPresentGatewayMethod } from "../../../lib/gateway-methods.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";

/** Unknown acquisition is pending; a known unavailable capability is a settled outcome. */
export function isProcessesPresentationReady(
  owner: ProcessesPanelData | undefined,
  gateway: ApplicationGatewaySnapshot | undefined,
): boolean {
  if (owner?.pendingRead) {
    return false;
  }
  if (
    gateway?.hello &&
    !canPresentGatewayMethod(gateway, "sessions.processes.list", "operator.read")
  ) {
    return true;
  }
  const snapshot = owner?.snapshot;
  return Boolean(snapshot?.hasResult || snapshot?.errorKind);
}

/** Presents shared, already-admitted process work without starting another read. */
export function createProcessesPresentation(
  source: () => ProcessesPanelData | undefined,
  retainRows = false,
) {
  const pending = createMemo(() => ({ completion: source()?.pendingRead ?? null }), {
    equals: (a, b) => a.completion === b.completion,
  });
  const scope = createMemo(
    () => {
      const owner = source();
      return owner
        ? { owner, retired: owner.retired, connectionRetired: owner.connectionRetired }
        : undefined;
    },
    {
      equals: (a, b) =>
        a?.owner === b?.owner &&
        a?.retired === b?.retired &&
        a?.connectionRetired === b?.connectionRetired,
    },
  );
  const isCurrent = (view: NonNullable<ReturnType<typeof scope>>) => {
    const owner = source();
    return (
      view.owner === owner &&
      view.retired === owner?.retired &&
      view.connectionRetired === owner?.connectionRetired
    );
  };
  const read = createMemo(() => {
    const view = scope();
    const admitted = pending().completion;
    if (!view?.connectionRetired) {
      return Promise.resolve();
    }
    return Promise.race([admitted ?? Promise.resolve(), view.retired, view.connectionRetired]).then(
      () => {
        const snapshot = view.owner.snapshot;
        if (isCurrent(view) && snapshot.readError && (!retainRows || !snapshot.rows.length)) {
          throw new Error(snapshot.readError);
        }
      },
    );
  });

  // Each row/control gets its own flag so simultaneous Stops remain independent.
  function createStop(row: () => SessionProcessSummary) {
    const presentation = createMemo(() => {
      const view = scope();
      if (!view?.connectionRetired) {
        return undefined;
      }
      const [saving, setSaving] = createOptimistic(false);
      return { ...view, saving, setSaving };
    });
    const present = action(function* (
      view: NonNullable<ReturnType<typeof presentation>>,
      admitted: Promise<void>,
      retirement: Promise<unknown>,
    ) {
      if (isCurrent(view)) {
        view.setSaving(true);
        affects(read);
      }
      yield Promise.race([admitted, retirement]);
      if (isCurrent(view)) {
        yield refresh(read);
      }
    });
    return {
      stopping: () =>
        Boolean(presentation()?.saving()) ||
        Boolean(source()?.snapshot.stopping.has(row().instanceId)),
      async stop() {
        const view = presentation();
        const currentRow = row();
        if (!view || !isCurrent(view)) {
          return;
        }
        const retirement = Promise.race([view.retired, view.connectionRetired]);
        const admitted = view.owner.stop(currentRow);
        // Admission publishes synchronously; presentation joins after that publication.
        await Promise.resolve();
        try {
          await present(view, admitted, retirement);
        } catch (error) {
          if (isCurrent(view) && !view.owner.snapshot.readError) {
            view.owner.reportStopError(currentRow, error);
          }
        }
      },
    };
  }
  return { read, scope, createStop };
}
