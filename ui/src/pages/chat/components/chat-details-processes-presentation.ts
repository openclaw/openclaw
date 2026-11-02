import { createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";

/** Details previews live work; the complete process collection retains history. */
export function createDetailsProcessesPresentation(rows: () => readonly SessionProcessSummary[]) {
  return createMemo(() => rows().filter((row) => row.status === "running"));
}
