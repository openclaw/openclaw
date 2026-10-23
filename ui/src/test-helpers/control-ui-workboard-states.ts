import { createControlUiMockSessionRow as sessionRow } from "./control-ui-session-fixtures.ts";

// State, display label, card column, and linked-session status.
const STATES = [
  ["unlinked", "No linked session", "todo", undefined],
  ["unknown", "Unknown session", "todo", undefined],
  ["unavailable", "Session unavailable", "todo", undefined],
  ["ambiguous", "Ambiguous session", "todo", undefined],
  ["idle", "Idle", "todo", undefined],
  ["queued", "Queued", "ready", "queued"],
  ["running", "Running", "running", "running"],
  ["stale", "No activity", "running", "running"],
  ["succeeded", "Done", "done", "done"],
  ["failed", "Failed", "review", "failed"],
  ["timed_out", "Timed out", "review", undefined],
  ["cancelled", "Cancelled", "review", undefined],
  ["stopped", "Stopped", "review", "killed"],
  ["blocked", "Waiting for operator approval", "blocked", undefined],
] as const;
export const MATRIX_STATES = STATES.map(([state]) => state);
const MATRIX_ALERTS = ["none", "same", "different"] as const;
const MATRIX_COUNTS = ["off", "on"] as const;
const MATRIX_PRIORITIES = ["normal", "high"] as const;

// SAFETY: every state contributes exactly one label in the table above.
export const WORKBOARD_STATE_LABELS = Object.fromEntries(
  STATES.map(([state, label]) => [state, label]),
) as Record<(typeof MATRIX_STATES)[number], string>;

export function buildWorkboardStateCells(now: number) {
  const createdAt = now - 120_000;
  const counters = (id: string) => ({
    comments: [{ id: `${id}-comment`, body: "Synthetic review comment.", createdAt }],
    proof: [{ id: `${id}-proof`, status: "passed", label: "Synthetic proof example", createdAt }],
  });
  return STATES.flatMap(([state, label, status]) =>
    MATRIX_ALERTS.flatMap((alert) =>
      MATRIX_COUNTS.flatMap((counts) =>
        MATRIX_PRIORITIES.map((priority) => {
          const id = `matrix-${state}-${alert}-${counts}-${priority}`;
          return {
            state,
            alert,
            counts,
            priority,
            id,
            card: {
              id,
              title: `${label} · ${alert} alert · counters ${counts}`,
              status,
              priority,
              labels: [],
              notes: "Synthetic presentation matrix; not evidence of a real execution.",
              sessionKey:
                state === "unlinked" || state === "blocked"
                  ? undefined
                  : `agent:main:matrix-${state}`,
              position:
                MATRIX_ALERTS.indexOf(alert) * 4 +
                MATRIX_COUNTS.indexOf(counts) * 2 +
                MATRIX_PRIORITIES.indexOf(priority),
              createdAt: now - 86_400_000,
              updatedAt: now - 120_000,
              metadata: {
                automation: { boardId: `matrix-${state}` },
                ...(counts === "on" ? counters(id) : {}),
                ...(state === "blocked"
                  ? {
                      workerProtocol: {
                        state: "blocked",
                        detail: label,
                        updatedAt: now - 120_000,
                      },
                    }
                  : {}),
              },
            },
          };
        }),
      ),
    ),
  );
}

const cellsById = new Map(buildWorkboardStateCells(0).map((cell) => [cell.id, cell]));

export function getWorkboardStateCell(id: string) {
  return cellsById.get(id);
}

export function buildWorkboardStateSessions(baseTime: number) {
  return [
    ...STATES.filter(
      ([state]) => !["unlinked", "blocked", "unknown", "unavailable", "ambiguous"].includes(state),
    ).map(([state, _label, _cardStatus, status]) =>
      sessionRow(
        `agent:main:matrix-${state}`,
        "Release verification",
        state === "stale" ? baseTime - 45 * 60_000 : baseTime - 120_000,
        {
          status,
          hasActiveRun: state === "running",
          ...(state === "running"
            ? { startedAt: baseTime - 8 * 60_000, activeRunIds: [`run-matrix-${state}`] }
            : {}),
        },
      ),
    ),
    sessionRow("agent:main:card-states-stale", "Natural stale session", baseTime - 45 * 60_000, {
      status: "running",
      hasActiveRun: false,
    }),
  ];
}
