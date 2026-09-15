import { t } from "../../i18n/index.ts";
import { discardConfigFormValue } from "./config-draft-model.ts";
import {
  loadConfig,
  type ConfigSubmission,
  type ConfigSubmissionObserver,
} from "./config-gateway-operations.ts";
import {
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  type RuntimeConfigState,
} from "./config-state-model.ts";

export function createConfigFieldDiscard(options: {
  state: RuntimeConfigState;
  serialize: (task: () => Promise<boolean>) => Promise<boolean>;
  holdAutoSave: () => (resume: boolean) => void;
  isDisposed: () => boolean;
  publish: () => void;
  reconcileDraft: () => void;
}) {
  const { state } = options;
  let lastSubmission: ConfigSubmission | null = null;
  const pending = new Set<{ path: Array<string | number>; current: boolean }>();
  const invalidate = (path?: Array<string | number>) => {
    for (const intent of pending) {
      if (
        !path ||
        path
          .slice(0, Math.min(path.length, intent.path.length))
          .every((part, index) => part === intent.path[index])
      ) {
        intent.current = false;
      }
    }
  };
  return {
    invalidate,
    resetConnection: () => {
      invalidate();
      lastSubmission = null;
    },
    captureSubmissionObserver: (): ConfigSubmissionObserver => {
      const client = state.client;
      const epoch = currentConfigConnectionEpoch(state);
      // Capture at dispatch: a late old-connection response cannot replace
      // the outcome used to reconcile a new connection's canceled field.
      return (submission) => {
        if (client && !options.isDisposed() && isCurrentConfigConnection(state, client, epoch)) {
          lastSubmission = submission;
        }
      };
    },
    discard: async (path: Array<string | number>): Promise<boolean> => {
      const client = state.client;
      const epoch = currentConfigConnectionEpoch(state);
      if (!client || !state.connected || state.configFormMode !== "form") {
        return false;
      }
      const intent = { path: [...path], current: true };
      pending.add(intent);
      const release = options.holdAutoSave();
      let discarded = false;
      const current = () =>
        intent.current && !options.isDisposed() && isCurrentConfigConnection(state, client, epoch);
      try {
        discarded = await options.serialize(async () => {
          const submitted = lastSubmission;
          if (!current() || !(await loadConfig(state)) || !current()) {
            return false;
          }
          if (state.configRecoveryError !== null) {
            return false;
          }
          if (
            submitted &&
            !submitted.ack &&
            !submitted.rejected &&
            state.configSnapshot?.raw !== submitted.raw
          ) {
            state.lastError = t("configView.discardUnconfirmed");
            state.configRecoveryError = state.lastError;
            state.configAutoSaveStatus = "error";
            return false;
          }
          // The fresh snapshot includes confirmed writes; removing only the
          // canceled intent must never restore a pre-ack reference over them.
          return discardConfigFormValue(state, intent.path);
        });
        return discarded;
      } finally {
        pending.delete(intent);
        options.reconcileDraft();
        release(discarded);
        options.publish();
      }
    },
  };
}
