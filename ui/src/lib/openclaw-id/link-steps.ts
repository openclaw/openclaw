// The four linking steps Make reachable shows (OCF-286), each tied to what
// actually happens: the owner key signs the claw's binding in this browser;
// the Gateway pins the owner key and admits this browser over loopback;
// the claw registers with Discovery, proving it holds its Gateway key, which
// reserves the address; and the claw's outbound relay connection is up, which the dialog
// keeps checking while it stays open.
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
};

/** Messages for the non-fatal outcomes, supplied by the dialog's catalog. */
export type LinkStepMessages = {
  notPublished: (publication: OpenClawIdPublication | null) => string;
};

/** How often the relay step reads the claw's relay connection while the dialog is open. */
export const RELAY_CHECK_INTERVAL_MS = 2_000;
/** How long the relay step shows progress before it warns that the relay isn't up yet. */
export const RELAY_GRACE_MS = 30_000;

/** What the relay step needs; injected so the watch is testable without a Gateway or timers. */
export type RelayWatch = {
  /** Whether the claw's relay connection is up right now. */
  relayOnline: () => Promise<boolean>;
  /** Resolves after `ms`. */
  sleep: (ms: number) => Promise<void>;
  /** False once the dialog has closed; the watch then stops without reporting. */
  active: () => boolean;
  /** Milliseconds since an arbitrary origin. */
  now: () => number;
};

/**
 * Runs the signing, pinning and registration steps in order and reports each state change.
 * A failure in signing or pinning stops the sequence and rejects; an unpublished claw is a
 * warning, because the claw is linked and the Gateway keeps trying on its own. Resolves with
 * the publication outcome; the relay step is `watchRelay`'s.
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
  return publication;
}

/**
 * Reports the relay step from the claw's current relay connection, which comes up a few
 * seconds after the commit. It reads the status every `RELAY_CHECK_INTERVAL_MS` until the
 * relay is online, then reports done. Before then the step runs; after `RELAY_GRACE_MS` it
 * warns with `offline`, and keeps reading so the step turns done once the relay connects.
 * Stops as soon as `watch.active()` is false.
 */
export async function watchRelay(
  watch: RelayWatch,
  offline: string,
  report: (step: LinkStep, state: LinkStepState) => void,
): Promise<void> {
  const started = watch.now();
  let warned = false;
  report("relay", { state: "running" });
  for (;;) {
    const online = await watch.relayOnline().catch(() => false);
    if (!watch.active()) {
      return;
    }
    if (online) {
      report("relay", { state: "done" });
      return;
    }
    if (!warned && watch.now() - started >= RELAY_GRACE_MS) {
      warned = true;
      report("relay", { state: "warning", message: offline });
    }
    await watch.sleep(RELAY_CHECK_INTERVAL_MS);
    if (!watch.active()) {
      return;
    }
  }
}
