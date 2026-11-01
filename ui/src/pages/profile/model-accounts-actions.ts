import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  refresh,
} from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import type { ModelAccountsState } from "./model-accounts-state.ts";

type Link = { provider: string; authProfileId: string };
type ExpectedLink = { kind: "select"; link: Link } | { kind: "unlink"; provider: string };

export function createModelAccountsActions(readState: () => ModelAccountsState) {
  const scope = createMemo(
    () => {
      const state = readState();
      return { target: state.target, connected: state.connected, hello: state.hello };
    },
    {
      equals: (a, b) => a.target === b.target && a.connected === b.connected && a.hello === b.hello,
    },
  );
  const presentation = createMemo(() => {
    const current = scope();
    const ownerLinks = createMemo(() => readState().links);
    const [links, setLinks] = createOptimisticStore<Link[]>(
      () => ownerLinks().map(({ provider, authProfileId }) => ({ provider, authProfileId })),
      [],
      { key: "provider" },
    );
    const flow = createMemo(() => readState().connectFlow);
    const [saving, setSaving] = createOptimistic(false);
    return { ...current, links, setLinks, flow, saving, setSaving };
  });

  const present = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<unknown>,
    retired: Promise<void>,
    generation: number,
    expected?: ExpectedLink,
  ) {
    const isCurrent = () => {
      const state = readState();
      return (
        state.target === view.target &&
        state.connected === view.connected &&
        state.hello === view.hello &&
        state.generation === generation &&
        state.actionRetired === retired
      );
    };
    try {
      if (isCurrent()) {
        view.setSaving(true);
        if (expected) {
          view.setLinks((links) => {
            const provider =
              expected.kind === "select" ? expected.link.provider : expected.provider;
            const index = links.findIndex((link) => link.provider === provider);
            const linked = links[index];
            if (expected.kind === "unlink") {
              if (index !== -1) {
                links.splice(index, 1);
              }
            } else if (!linked) {
              links.push(expected.link);
            } else {
              linked.authProfileId = expected.link.authProfileId;
            }
          });
        }
        affects(view.links);
        affects(view.flow);
      }
      // Cancelling an answer releases its presentation before the old RPC returns.
      yield Promise.race([pending, retired]);
      if (isCurrent()) {
        // The existing owner has already accepted or rejected the Gateway result.
        yield Promise.all([refresh(view.links), refresh(view.flow)]);
      }
    } catch (error) {
      if (isCurrent()) {
        const state = readState();
        state.error = formatUiError(error);
        state.publish();
      }
    }
  });

  async function run(
    command: (state: ModelAccountsState) => Promise<unknown> | undefined,
    expected?: ExpectedLink,
  ) {
    const state = readState();
    const view = presentation();
    const previousGeneration = state.generation;
    const pending = command(state);
    if (!pending || state.generation === previousGeneration) {
      return pending;
    }
    const generation = state.generation;
    const retired = state.actionRetired;
    // Publish synchronous admission and secret erasure before joining the transition.
    await Promise.resolve();
    return present(view, pending, retired, generation, expected);
  }

  return {
    links: () => presentation().links,
    flow: () => presentation().flow(),
    saving: () => presentation().saving(),
    updateAccount(kind: "link" | "unlink" | "select", value: string) {
      const account = readState().accounts.find((entry) => entry.authProfileId === value);
      return run(
        (state) => state.updateAccount(kind, value),
        kind === "unlink"
          ? { kind, provider: value }
          : kind === "select" && account
            ? { kind, link: { provider: account.provider, authProfileId: value } }
            : undefined,
      );
    },
    startConnect: () => run((state) => state.startConnect()),
    answerStep: (stepId: string, value: unknown) => run((state) => state.answerStep(stepId, value)),
    cancel: () => run((state) => state.connectStatus("cancel")),
  };
}

export type ModelAccountsActions = ReturnType<typeof createModelAccountsActions>;
