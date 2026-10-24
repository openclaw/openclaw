import { action, createOptimistic, onSettled } from "solid-js";
import type { SetupAutoCandidate } from "./custodian-auto-setup.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import type { CustodianMessage } from "./transcript.ts";

export type CustodianActions = ReturnType<typeof createCustodianActions>["actions"];
export type CustodianSetupActions = CustodianActions["setup"];

/** Shared by the full page and the standalone compact surface. */
export function createCustodianActions(getStore: () => CustodianSessionStore) {
  const [verifying, setVerifying] = createOptimistic(false);
  const [answering, setAnswering] = createOptimistic(false);
  const [cancelling, setCancelling] = createOptimistic(false);
  const [sending, setSending] = createOptimistic(false);
  const lifetimes = new Set<() => void>();
  const retire = () => lifetimes.forEach((resolve) => resolve());
  onSettled(() => retire);

  type Kind = "verification" | "wizard" | "cancellation" | "session";
  const present = action(function* (kind: Kind, pending: Promise<unknown>, retired: Promise<void>) {
    if (kind === "verification") {
      setVerifying(true);
    } else if (kind === "wizard") {
      setAnswering(true);
    } else if (kind === "cancellation") {
      setCancelling(true);
    } else {
      setSending(true);
    }
    yield Promise.race([pending, retired]);
  });

  async function run(kind: Kind, command: (source: CustodianSessionStore) => Promise<unknown>) {
    const source = getStore();
    const setup = source.autoSetup;
    // Admission stays synchronous, including reserving the sign-in window in the user gesture.
    const pending = command(source);
    const currentEpoch = () => (kind === "session" ? source.operationEpoch : setup.operationEpoch);
    const epoch = currentEpoch();
    const lifetime = Promise.withResolvers<void>();
    const isCurrent = () =>
      getStore() === source && currentEpoch() === epoch && (kind === "session" || !setup.dismissed);
    const isWorking = () => {
      if (kind === "session") {
        return source.sending;
      }
      const phase = setup.wizard.state;
      if (kind === "verification") {
        return setup.pending;
      }
      if (kind === "cancellation") {
        return phase.phase !== "idle";
      }
      return setup.pending || phase.phase === "starting" || (phase.phase === "step" && phase.busy);
    };
    const release = () => {
      if (!isCurrent() || !isWorking()) {
        lifetime.resolve();
      }
    };
    lifetimes.add(lifetime.resolve);
    const stop = source.subscribe(release);
    release();
    // Session children finish mounting before the action can hold their effects.
    // Setup cancellation must remain able to interrupt an already pending answer.
    await (kind === "session"
      ? new Promise<void>((resolve) => {
          onSettled(resolve);
        })
      : Promise.resolve());
    try {
      if (isCurrent() && isWorking()) {
        await present(kind, pending, lifetime.promise);
      } else {
        await Promise.race([pending, lifetime.promise]);
      }
    } catch (error) {
      if (isCurrent()) {
        if (kind === "session") {
          source.reportError(error);
        } else {
          setup.reportError(error);
        }
      }
    } finally {
      stop();
      lifetimes.delete(lifetime.resolve);
    }
  }

  const setup = {
    get verifying() {
      return verifying();
    },
    get answering() {
      return answering();
    },
    get cancelling() {
      return cancelling();
    },
    activate: (candidate: SetupAutoCandidate) =>
      void run("verification", (source) => source.autoSetup.activate(candidate)),
    retry: () => void run("verification", (source) => source.autoSetup.retry()),
    signIn: () => void run("wizard", (source) => source.autoSetup.signIn()),
    answer: (value: unknown) =>
      void run("wizard", (source) => source.autoSetup.answerWizard(value)),
    cancel: () => void run("cancellation", (source) => source.autoSetup.cancelWizard()),
  };
  const session = {
    get sending() {
      return sending();
    },
    send: () => void run("session", (source) => source.send()),
    retry: () => void run("session", (source) => source.retry()),
    sendEventNudge: () => void run("session", (source) => source.sendEventNudge()),
    answerQuestion: (message: CustodianMessage, label: string) =>
      void run("session", (source) => source.answerQuestion(message, label)),
    dismissQuestion: (message: CustodianMessage) =>
      void run("session", (source) => source.dismissQuestion(message)),
    answerWizardStep: (message: CustodianMessage, value: unknown) =>
      void run("session", (source) => source.answerWizardStep(message, value)),
    cancelWizardStep: (message: CustodianMessage) =>
      void run("session", (source) => source.cancelWizardStep(message)),
  };
  return { actions: { setup, session }, retire };
}
