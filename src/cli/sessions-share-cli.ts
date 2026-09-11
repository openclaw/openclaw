// `openclaw sessions share`: the device-side half of sharing local sessions with
// a team Gateway. Offers arrive through the node host; this is where the person
// who owns the laptop says yes or no. Runs against local state only.
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  decideLocalSessionOffer,
  readLocalSessionConsentState,
} from "../node-host/local-session-consent-store.js";
import { defaultRuntime } from "../runtime.js";
import { ExpectedCliError } from "./failure-output.js";

export type SessionsShareCliOptions = {
  accept?: string;
  decline?: string;
  json?: boolean;
};

function cliError(message: string): ExpectedCliError {
  return new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export async function runSessionsShareCli(opts: SessionsShareCliOptions): Promise<void> {
  const runtime = defaultRuntime;
  if (opts.accept && opts.decline) {
    throw cliError("Use either --accept or --decline, not both.");
  }
  const decisionId = opts.accept ?? opts.decline;
  if (decisionId) {
    const decision = opts.accept ? "accepted" : "declined";
    const consent = decideLocalSessionOffer({ enrollmentId: decisionId, decision });
    if (!consent) {
      throw cliError(
        `No pending sharing request "${decisionId}". Run \`openclaw sessions share\` to list requests.`,
      );
    }
    if (opts.json) {
      runtime.log(JSON.stringify({ decision, consent }, null, 2));
      return;
    }
    runtime.log(
      decision === "accepted"
        ? `${theme.success("Sharing accepted.")} ${consent.enrollment.requester.displayName}'s team Gateway will show your ${consent.sourceId} sessions in agent "${consent.enrollment.agentId}" as soon as this node host delivers the decision (within a few seconds while it is connected).`
        : `${theme.warn("Sharing declined.")} The request from ${consent.enrollment.requester.displayName} is closed.`,
    );
    return;
  }
  const state = readLocalSessionConsentState();
  if (opts.json) {
    runtime.log(JSON.stringify(state, null, 2));
    return;
  }
  if (state.preconsents.length > 0) {
    runtime.log(theme.heading("Accepted in advance"));
    for (const entry of state.preconsents) {
      runtime.log(
        `  ${entry.sourceId}  the next sharing request for this source is accepted automatically ${theme.muted(`(from openclaw connect --share, ${formatAge(entry.decidedAtMs)})`)}`,
      );
    }
  }
  if (state.offers.length === 0 && state.consents.length === 0 && state.preconsents.length === 0) {
    runtime.log(
      `${theme.muted("No sharing requests.")} Ask a teammate to open the team Gateway's Devices page and choose "Share sessions" for this device; the request appears here.`,
    );
    return;
  }
  if (state.offers.length > 0) {
    runtime.log(theme.heading("Pending requests"));
    for (const offer of state.offers) {
      runtime.log(
        `  ${offer.enrollment.enrollmentId}  ${offer.sourceId} sessions → agent "${offer.enrollment.agentId}", requested by ${offer.enrollment.requester.displayName} ${theme.muted(formatAge(offer.receivedAtMs))}`,
      );
      runtime.log(
        `    audience: ${offer.enrollment.audienceLabel}. Teammates who can send will be able to steer these sessions with your local tools.`,
      );
      runtime.log(
        `    ${theme.muted(`openclaw sessions share --accept ${offer.enrollment.enrollmentId}`)}`,
      );
    }
  }
  if (state.consents.length > 0) {
    runtime.log(theme.heading("Decided"));
    for (const consent of state.consents) {
      runtime.log(
        `  ${consent.enrollment.enrollmentId}  ${consent.sourceId} → ${consent.decision}${consent.deliveredAtMs ? "" : theme.muted(" (delivery pending)")} ${theme.muted(formatAge(consent.decidedAtMs))}`,
      );
    }
  }
}
