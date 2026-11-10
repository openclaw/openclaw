// The four linking steps Make reachable shows (OCF-286), each tied to what
// actually happens: the owner key signs the claw's binding in this browser;
// the Gateway pins the owner key and admits this browser over loopback;
// the claw registers with Discovery, proving it holds its Gateway key, which
// reserves the address; and the claw's outbound relay connection is up.
import type { OpenClawIdPublication } from "./types.ts";

/** The steps, in the order the dialog shows them. */
export const LINK_STEPS = ["sign", "pin", "reserve", "relay"] as const;
export type LinkStep = (typeof LINK_STEPS)[number];

/** A step's state: waiting, running, done, done with a warning, or failed. */
export type LinkStepState =
  | { state: "waiting" }
  | { state: "running" }
  | { state: "done" }
  | { state: "warning"; message: string }
  | { state: "failed"; message: string };

/** What each step needs; injected so the sequence is testable without a Gateway. */
export type LinkStepActions = {
  /** Signs the owner-device certificate and the server binding with the owner key. */
  sign: () => Promise<void>;
  /** Commits the signed statements; resolves with the Discovery publication outcome. */
  commit: () => Promise<OpenClawIdPublication | null>;
  /** Whether the claw's relay connection is up right now. */
  relayOnline: () => Promise<boolean>;
};

/** Messages for the non-fatal outcomes, supplied by the dialog's catalog. */
export type LinkStepMessages = {
  notPublished: (publication: OpenClawIdPublication | null) => string;
  relayOffline: string;
};

/**
 * Runs the steps in order and reports each state change. A failure in signing
 * or pinning stops the sequence and rejects; an unpublished claw or a relay
 * that isn't up yet is a warning, because the claw is linked and the Gateway
 * keeps trying on its own. Resolves with the publication outcome.
 */
export async function runLinkSteps(
  actions: LinkStepActions,
  messages: LinkStepMessages,
  report: (step: LinkStep, state: LinkStepState) => void,
): Promise<OpenClawIdPublication | null> {
  // Signing and pinning must succeed; any error rejects with the step marked failed.
  const required = async <T>(step: LinkStep, action: () => Promise<T>): Promise<T> => {
    report(step, { state: "running" });
    try {
      const result = await action();
      return result;
    } catch (error) {
      report(step, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  await required("sign", actions.sign);
  report("sign", { state: "done" });
  const publication = await required("pin", actions.commit);
  report("pin", { state: "done" });
  // Registration with Discovery is the possession proof and the name reservation.
  report("reserve", { state: "running" });
  if (publication?.state === "published") {
    report("reserve", { state: "done" });
  } else {
    report("reserve", { state: "warning", message: messages.notPublished(publication) });
  }
  report("relay", { state: "running" });
  const online = await actions.relayOnline().catch(() => false);
  report(
    "relay",
    online ? { state: "done" } : { state: "warning", message: messages.relayOffline },
  );
  return publication;
}
