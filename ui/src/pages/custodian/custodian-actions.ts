import { action, createOptimistic, onSettled } from "solid-js";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import type { CustodianMessage } from "./transcript.ts";

export type CustodianActions = ReturnType<typeof createCustodianActions>["actions"];

/** Shared by the full page and the standalone compact surface. */
export function createCustodianActions(getStore: () => CustodianSessionStore) {
  const [sending, setSending] = createOptimistic(false);
  const lifetimes = new Set<() => void>();
  const retire = () => lifetimes.forEach((resolve) => resolve());
  onSettled(() => retire);

  const present = action(function* (pending: Promise<unknown>, retired: Promise<void>) {
    setSending(true);
    yield Promise.race([pending, retired]);
  });

  async function run(command: (source: CustodianSessionStore) => Promise<unknown>) {
    const source = getStore();
    const pending = command(source);
    const epoch = source.operationEpoch;
    const lifetime = Promise.withResolvers<void>();
    const isCurrent = () => getStore() === source && source.operationEpoch === epoch;
    const isWorking = () => source.sending;
    const release = () => {
      if (!isCurrent() || !isWorking()) {
        lifetime.resolve();
      }
    };
    lifetimes.add(lifetime.resolve);
    const stop = source.subscribe(release);
    release();
    // Session children finish mounting before the action can hold their effects.
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    try {
      if (isCurrent() && isWorking()) {
        await present(pending, lifetime.promise);
      } else {
        await Promise.race([pending, lifetime.promise]);
      }
    } catch (error) {
      if (isCurrent()) {
        source.reportError(error);
      }
    } finally {
      stop();
      lifetimes.delete(lifetime.resolve);
    }
  }

  const session = {
    get sending() {
      return sending();
    },
    send: () => void run((source) => source.send()),
    retry: () => void run((source) => source.retry()),
    sendEventNudge: () => void run((source) => source.sendEventNudge()),
    answerQuestion: (message: CustodianMessage, label: string) =>
      void run((source) => source.answerQuestion(message, label)),
    dismissQuestion: (message: CustodianMessage) =>
      void run((source) => source.dismissQuestion(message)),
    answerWizardStep: (message: CustodianMessage, value: unknown) =>
      void run((source) => source.answerWizardStep(message, value)),
    cancelWizardStep: (message: CustodianMessage) =>
      void run((source) => source.cancelWizardStep(message)),
  };
  return { actions: { session }, retire };
}
