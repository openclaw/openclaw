import { createMemo } from "solid-js";
import type { ProcessesPanelData } from "../processes-panel-data.ts";

/** Details previews live work; hidden terminal history cannot hide read failures. */
export function createDetailsProcessesPresentation(
  source: () => ProcessesPanelData["snapshot"] | undefined,
) {
  const rows = createMemo(() => source()?.rows.filter((row) => row.status === "running") ?? []);
  const error = () => {
    const snapshot = source();
    return snapshot?.errorKind === "read" && rows().length > 0 ? null : (snapshot?.error ?? null);
  };
  return { rows, error };
}
