import { createControlUiMockSessionRow as sessionRow } from "./control-ui-session-fixtures.ts";

export const MATRIX_STATES = [
  "unlinked",
  "unknown",
  "unavailable",
  "ambiguous",
  "idle",
  "queued",
  "running",
  "stale",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "stopped",
  "blocked",
] as const;
const MATRIX_ALERTS = ["none", "same", "different"] as const;
const MATRIX_COUNTS = ["off", "on"] as const;
const MATRIX_PRIORITIES = ["normal", "high"] as const;

export const WORKBOARD_STATE_LABELS: Record<(typeof MATRIX_STATES)[number], string> = {
  unlinked: "No linked session",
  unknown: "Unknown session",
  unavailable: "Session unavailable",
  ambiguous: "Ambiguous session",
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  stale: "No activity",
  succeeded: "Done",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  stopped: "Stopped",
  blocked: "Waiting for operator approval",
};

export function buildWorkboardStateCells(now: number) {
  return MATRIX_STATES.flatMap((state) =>
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
              title: `${WORKBOARD_STATE_LABELS[state]} · ${alert} alert · counters ${counts}`,
              status:
                state === "blocked"
                  ? "blocked"
                  : state === "succeeded"
                    ? "done"
                    : state === "queued"
                      ? "ready"
                      : state === "running" || state === "stale"
                        ? "running"
                        : ["failed", "timed_out", "cancelled", "stopped"].includes(state)
                          ? "review"
                          : "todo",
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
                ...(counts === "on"
                  ? {
                      comments: [
                        {
                          id: `${id}-comment`,
                          body: "Synthetic review comment.",
                          createdAt: now - 120_000,
                        },
                      ],
                      proof: [
                        {
                          id: `${id}-proof`,
                          status: "passed",
                          label: "Synthetic proof example",
                          createdAt: now - 120_000,
                        },
                      ],
                    }
                  : {}),
                ...(state === "blocked"
                  ? {
                      workerProtocol: {
                        state: "blocked",
                        detail: "Waiting for operator approval",
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
    ...MATRIX_STATES.filter(
      (state) => !["unlinked", "blocked", "unknown", "unavailable", "ambiguous"].includes(state),
    ).map((state) =>
      sessionRow(
        `agent:main:matrix-${state}`,
        "Release verification",
        state === "stale" ? baseTime - 45 * 60_000 : baseTime - 120_000,
        {
          status:
            state === "idle" || state === "cancelled" || state === "timed_out"
              ? undefined
              : state === "succeeded"
                ? "done"
                : state === "stopped"
                  ? "killed"
                  : state === "stale"
                    ? "running"
                    : state,
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
