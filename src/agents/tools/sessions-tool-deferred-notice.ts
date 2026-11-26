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
export async function reportDeferredSessionVisibilityFailure(params: {
  operation: "archive" | "snooze";
  target: { agentId: string; storePath: string; sessionKey: string; sessionId: string };
  gateway: ReturnType<typeof getInProcessGatewayToolContext>;
  assertCurrent?: SessionSourceAssertion;
}) {
  const { operation, target } = params;
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
                : "The scheduled session snooze could not be confirmed. Check whether this session is snoozed before trying again.",
            display: true,
            excludeFromContext: true,
            details: { operation, outcome: "unconfirmed" },
          }),
        }),
    ),
  );
  if (!report.ok) {
    throw new Error("Session visibility notice unavailable: " + report.error.code);
  }
}
