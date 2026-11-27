import { appendSessionTranscriptReport } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";
import { captureSessionControlAuthority } from "./sessions-operator-authority.js";

/** Report the accepted operation only to its requesting transcript. Never repeat a
 * transport error to the user: its details may be private and its outcome uncertain. */
export async function reportDeferredSessionVisibilityFailure(
  params: (
    | { operation: "archive"; outcome?: never }
    | { operation: "snooze"; outcome: "failed" | "unconfirmed" }
  ) & {
    target: { agentId: string; storePath: string; sessionKey: string; sessionId: string };
    gateway: ReturnType<typeof getInProcessGatewayToolContext>;
    assertCurrent?: SessionSourceAssertion;
  },
) {
  const { operation, outcome = "unconfirmed", target } = params;
  const customType = `session-${operation}-failed`;
  const source = captureSessionControlAuthority();
  const report = await runWithoutOwnedSessionTranscriptWrites(() =>
    withSessionTranscriptWriteAssertion(
      target,
      composeSessionSourceAssertion(
        [source?.assertCurrent, params.assertCurrent],
        (assertSources) => {
          assertSources();
          if (getInProcessGatewayToolContext() !== params.gateway) {
            throw new Error("Deferred session visibility notice belongs to another Gateway");
          }
        },
      ),
      () =>
        appendSessionTranscriptReport(target, {
          kind: "custom",
          customTypes: [customType],
          selectReport: () => ({
            customType,
            content:
              operation === "archive"
                ? "The scheduled session archive could not be confirmed. Check whether this session is archived before trying again."
                : outcome === "failed"
                  ? "The requested snooze time isn’t set. You can ask me to try again."
                  : "I couldn’t confirm the snooze. You can ask me to set a new time.",
            display: true,
            excludeFromContext: true,
            details: { operation, outcome },
          }),
        }),
    ),
  );
  if (!report.ok) {
    // The transcript writer, not the chat's visibility read, decides whether a
    // snooze notice still belongs here. Never redirect it after rollover.
    if (operation === "snooze" && report.error.code === "session-rebound") {
      return;
    }
    throw new Error("Session visibility notice unavailable: " + report.error.code);
  }
}
