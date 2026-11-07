import { action, createMemo, createOptimistic, refresh } from "solid-js";
import type { SubagentsPanelData, SubagentsPanelRow } from "../subagents-panel-data.ts";

/** Consumes the owner's admitted list readiness; optional metrics never hold it. */
export function createSubagentsPresentation(source: () => SubagentsPanelData) {
  const receipt = createMemo(() => ({ completion: source().readResult }), {
    equals: (a, b) => a.completion === b.completion,
  });
  const failure = createMemo(() => source().readError);
  const scope = createMemo(
    () => {
      const owner = source();
      return { owner, retired: owner.retired };
    },
    { equals: (a, b) => a.owner === b.owner && a.retired === b.retired },
  );
  const isCurrent = (view: ReturnType<typeof scope>) =>
    source() === view.owner && source().retired === view.retired;
  const read = createMemo(() => {
    const view = scope();
    const { completion } = receipt();
    failure();
    return Promise.race([completion, view.retired]).then(() => {
      if (isCurrent(view) && view.owner.readError) {
        throw new Error(view.owner.readError);
      }
    });
  });

  function createStop(row: () => SubagentsPanelRow | undefined) {
    const presentation = createMemo(() => {
      const view = scope();
      const [saving, setSaving] = createOptimistic(false);
      return { ...view, saving, setSaving };
    });
    const present = action(function* (
      view: ReturnType<typeof presentation>,
      admitted: Promise<void>,
      retirement: Promise<void>,
    ) {
      if (isCurrent(view)) {
        view.setSaving(true);
      }
      yield Promise.race([admitted, retirement]);
      // The owner admits list refresh after acknowledgement; earlier pending would hold navigation.
      if (isCurrent(view)) {
        void refresh(read);
      }
    });
    // Mobile captures this before opening confirmation, preserving its target/run.
    const capture = () => {
      const view = presentation();
      const target = row();
      const retirement = view.retired;
      return async () => {
        if (!target || !isCurrent(view)) {
          return;
        }
        const admitted = view.owner.stop(target);
        // Owner admission publishes synchronously before the action joins this tick.
        await Promise.resolve();
        try {
          await present(view, admitted, retirement);
        } catch (error) {
          if (isCurrent(view) && !view.owner.readError) {
            view.owner.reportStopError(error);
          }
        }
      };
    };
    return {
      stopping: () => presentation().saving() || Boolean(row()?.stopping),
      capture,
      stop: () => capture()(),
    };
  }
  return { read, scope, createStop };
}

export type SubagentStopControl = ReturnType<
  ReturnType<typeof createSubagentsPresentation>["createStop"]
>;
