import { action, createMemo, createOptimistic } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";

/** Wizard steps and Start Chat share presentation, never mutation authority. */
export function createLoginSavingPresentation(options: {
  getScope: () => { context: ApplicationContext; connectionEpoch: number; agentId: string | null };
  observe: () => void;
  notify: () => void;
}) {
  let identity:
    | {
        client: ApplicationContext["gateway"]["snapshot"]["client"];
        epoch: number;
        agentId: string | null;
      }
    | undefined;
  let lifetime = Promise.withResolvers<void>();
  const scope = createMemo(() => {
    options.observe();
    return identity;
  });
  function reset(): void {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
    identity = undefined;
  }
  function synchronize(): void {
    const current = options.getScope();
    const next = {
      client: current.context.gateway.snapshot.client,
      epoch: current.connectionEpoch,
      agentId: current.agentId,
    };
    if (
      identity?.client === next.client &&
      identity.epoch === next.epoch &&
      identity.agentId === next.agentId
    ) {
      return;
    }
    // Synchronous scope retirement releases pending presentation before publication.
    reset();
    identity = next;
    options.notify();
  }
  const presentation = createMemo(() => {
    scope();
    const [wizardSaving, setWizardSaving] = createOptimistic(false);
    const [chatSaving, setChatSaving] = createOptimistic(false);
    return { wizardSaving, setWizardSaving, chatSaving, setChatSaving };
  });
  const present = action(function* (
    showSaving: () => void,
    operation: Promise<void>,
    retired: Promise<void>,
    isCurrent: () => boolean,
    failed: (error: unknown) => void,
  ) {
    try {
      if (isCurrent()) {
        showSaving();
      }
      yield Promise.race([operation, retired]);
    } catch (error) {
      if (isCurrent()) {
        failed(error);
      }
    }
  });

  return {
    synchronize,
    reset,
    dispose: () => lifetime.resolve(),
    retired: () => lifetime.promise,
    wizardSaving: () => presentation().wizardSaving(),
    chatSaving: () => presentation().chatSaving(),
    async run(
      kind: "wizard" | "chat",
      operation: Promise<void>,
      retired: Promise<void>,
      isCurrent: () => boolean,
      failed: (error: unknown) => void,
    ): Promise<void> {
      // Commit the owner's admission and scope before joining its presentation.
      await Promise.resolve();
      const display = presentation();
      return present(
        () => (kind === "wizard" ? display.setWizardSaving(true) : display.setChatSaving(true)),
        operation,
        retired,
        isCurrent,
        failed,
      );
    },
  };
}
