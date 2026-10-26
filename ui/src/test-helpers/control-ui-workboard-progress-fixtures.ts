import type { createControlUiMockSessionRow } from "./control-ui-session-fixtures.ts";

type ProgressSession = Pick<
  ReturnType<typeof createControlUiMockSessionRow>,
  "key" | "updatedAt" | "status"
>;

export function buildWorkboardProgressResponses(
  baseTime: number,
  sessionKey: string,
  cardSessions: readonly ProgressSession[],
) {
  return {
    cases: [
      {
        match: { sessionKey },
        response: {
          card: {
            sessionKey,
            revision: 2,
            updatedAt: baseTime,
            markdown: "**Product launch** is moving through final checks.",
            steps: [
              { step: "Confirm release scope", status: "completed" },
              { step: "Validate onboarding flow", status: "in_progress" },
              { step: "Publish support handoff", status: "pending" },
            ],
          },
        },
      },
      ...cardSessions
        .filter((session) => !session.key.includes(":card-states-"))
        .map((session) => ({
          match: { sessionKey: session.key },
          response: {
            card: {
              sessionKey: session.key,
              revision: 1,
              updatedAt: session.updatedAt,
              markdown:
                session.status === "failed"
                  ? "Staging access could not be verified. The operator must confirm access before work continues."
                  : session.status === "done"
                    ? "The requested work is complete and ready for operator review."
                    : session.status === "running"
                      ? "Account setup passed. First-task navigation is being checked."
                      : "Waiting for the operator to provide the next input.",
              steps: [
                {
                  step: "Review the requested scope",
                  status: session.status === "queued" ? "pending" : "completed",
                },
                {
                  step: "Complete the requested work",
                  status:
                    session.status === "done"
                      ? "completed"
                      : session.status === "running"
                        ? "in_progress"
                        : "pending",
                },
              ],
            },
          },
        })),
      { response: { card: null } },
    ],
  };
}
