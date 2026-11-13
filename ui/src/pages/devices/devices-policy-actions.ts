import {
  action,
  affects,
  createMemo,
  createOptimistic,
  refresh,
  type Accessor,
  type Refreshable,
} from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DevicesPageDataState } from "../../lib/nodes/page-operations.ts";

type SaveScope = {
  state: DevicesPageDataState;
  gateway: ApplicationContext["gateway"] | null;
  epoch: number;
  target: string | null;
};

const SAVED_NOTICE_MS = 2400;

export function createDevicePolicyActions(options: {
  scope: Accessor<SaveScope>;
  canSave(): boolean;
  canEdit(): boolean;
  runtimeConfig(): ApplicationContext["runtimeConfig"];
  isCurrent(view: SaveScope): boolean;
  read(): Refreshable<Accessor<unknown>>;
  run(): Promise<unknown>;
  publish(): void;
}) {
  const scope = createMemo(options.scope, {
    equals: (a, b) =>
      a.state === b.state &&
      a.gateway === b.gateway &&
      a.epoch === b.epoch &&
      a.target === b.target,
  });
  const presentation = createMemo(() => {
    const current = scope();
    const [approvalsSaving, setApprovalsSaving] = createOptimistic(false);
    return { ...current, approvalsSaving, setApprovalsSaving };
  });
  let lifetime = Promise.withResolvers<void>();
  let savedNotice: { state: DevicesPageDataState; timer: ReturnType<typeof setTimeout> } | null =
    null;
  const clearSavedNotice = () => {
    if (savedNotice) {
      clearTimeout(savedNotice.timer);
      savedNotice.state.execApprovalsSavedNotice = false;
      savedNotice = null;
    }
  };
  const fadeSavedNotice = (state: DevicesPageDataState) => {
    if (savedNotice) {
      clearTimeout(savedNotice.timer);
    }
    savedNotice = {
      state,
      timer: setTimeout(() => {
        clearSavedNotice();
        options.publish();
      }, SAVED_NOTICE_MS),
    };
  };
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    currentLifetime: typeof lifetime,
    pending: Promise<unknown>,
  ) {
    const isCurrent = () => currentLifetime === lifetime && options.isCurrent(view);
    const snapshot = options.read();
    try {
      if (isCurrent()) {
        view.setApprovalsSaving(true);
        affects(snapshot);
      }
      // Retirement releases presentation; the plain owner still settles its write.
      yield Promise.race([pending, currentLifetime.promise]);
      if (isCurrent()) {
        yield refresh(snapshot);
      }
    } catch (error) {
      if (isCurrent()) {
        view.state.execApprovalsError = formatUiError(error);
        options.publish();
      }
    }
  });

  return {
    bindNode(nodeId: string | null, agentId?: string) {
      if (options.canEdit()) {
        const config = options.runtimeConfig();
        const target =
          agentId === undefined
            ? { path: [] }
            : config.agentEntry(agentId, { ensure: Boolean(nodeId) });
        if (!target) {
          return;
        }
        const path = [...target.path, "tools", "exec", "node"];
        if (nodeId) {
          config.patchForm(path, nodeId);
        } else {
          config.removeFormValue(path);
        }
      }
    },
    approvalsSaving: () => presentation().approvalsSaving(),
    retire() {
      clearSavedNotice();
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    async save() {
      if (!options.canSave()) {
        return;
      }
      const view = presentation();
      const currentLifetime = lifetime;
      const pending = options.run();
      void pending.then(
        () => fadeSavedNotice(view.state),
        () => undefined,
      );
      // Publish the owner's admitted operation before opening its presentation.
      await Promise.resolve();
      return present(view, currentLifetime, pending);
    },
  };
}
