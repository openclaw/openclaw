import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createSignal,
  onSettled,
  refresh,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SkillsState } from "../../lib/skills/index.ts";

type MutationScope = {
  client: GatewayBrowserClient | null;
  epoch: number;
  agentId: string | null;
  agentRevision: number;
};

export function createSkillsMutationPresentation(deps: {
  state: SkillsState;
  readSkills: () => SkillsState["skillsReport"];
  scope: () => MutationScope;
  readEpoch: () => number;
  active: () => boolean;
}) {
  let lifetime = Promise.withResolvers<void>();
  const acceptedSkills = createMemo(() => deps.readSkills()?.skills);
  const presentation = createMemo(() => {
    const scope = deps.scope();
    const [rows, setRows] = createOptimisticStore(() => acceptedSkills() ?? [], [], {
      key: "skillKey",
    });
    const [saving, setSaving] = createOptimistic(false);
    return { ...scope, rows, setRows, saving, setSaving };
  });
  const [toggle, setToggle] = createSignal<{
    view: ReturnType<typeof presentation>;
    intent: { skillKey: string; operation: SkillsState["skillOperation"] };
  } | null>(null);
  const presentMutation = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<void>,
    retired: Promise<void>,
    expected?: { skillKey: string; enabled: boolean },
  ) {
    if (isCurrent(view, retired)) {
      view.setSaving(true);
      if (expected) {
        view.setRows((rows) => {
          const row = rows.find((skill) => skill.skillKey === expected.skillKey);
          if (row) {
            row.disabled = !expected.enabled;
          }
        });
      }
      // Installs and credentials can also change Gateway-owned eligibility facts.
      affects(view.rows);
    }
    // Presentation retirement releases the route, never the admitted write.
    yield Promise.race([pending, retired]);
    if (isCurrent(view, retired)) {
      yield refresh(view.rows);
    }
  });

  function isCurrent(view: MutationScope, retired: Promise<void>) {
    return (
      deps.active() &&
      retired === lifetime.promise &&
      view.client === deps.state.client &&
      view.epoch === deps.readEpoch() &&
      view.agentId === deps.state.skillsAgentId &&
      view.agentRevision === deps.state.skillsAgentRevision
    );
  }

  return {
    rows: () => presentation().rows,
    saving: () => presentation().saving(),
    toggle: () => {
      const current = toggle();
      return current?.view === presentation() ? current.intent : null;
    },
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
      setToggle(null);
    },
    async run(task: () => Promise<void>, expected?: { skillKey: string; enabled: boolean }) {
      const view = presentation();
      const retired = lifetime.promise;
      let intent: ReturnType<typeof toggle> = null;
      try {
        const previous = deps.state.skillOperation;
        const pending = task();
        if (deps.state.skillOperation === previous) {
          await pending;
          return;
        }
        if (expected && isCurrent(view, retired)) {
          // The owner admitted this toggle synchronously. Present its saving state
          // before the deferred optimistic action, including its inventory refresh.
          intent = {
            view,
            intent: { skillKey: expected.skillKey, operation: deps.state.skillOperation },
          };
          setToggle(intent);
        }
        // Let owner publication and any just-opened dialog settle before joining.
        // Retirement can dispose an owned caller before that callback fires.
        await Promise.race([
          new Promise<void>((resolve) => {
            onSettled(resolve);
          }),
          retired,
        ]);
        await presentMutation(view, pending, retired, expected);
        await pending;
      } catch (error) {
        if (isCurrent(view, retired)) {
          deps.state.skillsError = formatUiError(error);
        }
      } finally {
        setToggle((current) => (current === intent ? null : current));
      }
    },
  };
}
