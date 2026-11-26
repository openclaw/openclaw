import { action, createOptimistic } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { DialogHeader } from "../../../components/solid/dialog-header.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerSessionMachineEnglish } from "../../../i18n/locales/en-session-machine.ts";
import "./session-worker-stop-dialog.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerSessionMachineEnglish);

/** The placement owner retains the captured identity and performs the effect. */
function SessionWorkerStopDialog(props: {
  description: string;
  title?: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => boolean;
}) {
  let cancelButton!: HTMLButtonElement;
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => cancelButton}
      class="session-worker-stop-dialog"
      label={props.title ?? t("sessionsView.workerStopTitle")}
      onModal-cancel={(event) => {
        if (!props.onCancel()) {
          event.preventDefault();
        }
      }}
    >
      <section class="oc-dialog">
        <DialogHeader
          title={props.title ?? t("sessionsView.workerStopTitle")}
          description={props.description}
          closeDisabled={props.pending}
          onClose={props.onCancel}
        />
        <openclaw-modal-actions class="oc-dialog__footer">
          <button
            type="button"
            class="btn"
            ref={(element) => (cancelButton = element)}
            autofocus
            disabled={props.pending}
            onClick={() => props.onCancel()}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn danger session-worker-stop__submit"
            disabled={props.pending}
            aria-busy={props.pending ? "true" : "false"}
            onClick={() => props.onConfirm()}
          >
            <span
              class="session-worker-stop__button-state"
              style={{ visibility: props.pending ? "hidden" : "visible" }}
              aria-hidden={props.pending ? "true" : "false"}
            >
              <Icon name="stop" />
              {t("sessionsView.stopWorkerConfirmAction")}
            </span>
            <span
              class="session-worker-stop__button-state"
              style={{ visibility: props.pending ? "visible" : "hidden" }}
              aria-hidden={props.pending ? "false" : "true"}
            >
              <span class="btn__spinner" />
              {t("sessionsView.workerStopping")}
            </span>
          </button>
        </openclaw-modal-actions>
      </section>
    </openclaw-modal-dialog>
  );
}

let stopDialogActive = false;

export async function showSessionWorkerStopDialog(options: {
  description: string;
  title?: string;
  confirm: () => Promise<"close" | "retry">;
}): Promise<void> {
  if (stopDialogActive) {
    return;
  }
  stopDialogActive = true;
  try {
    await withPromiseModalHost<void>(undefined, ({ render, finish }) => {
      render(() => {
        const [pending, setPending] = createOptimistic(false);
        let confirming = false;
        const cancel = () => {
          if (confirming) {
            return false;
          }
          finish();
          return true;
        };
        const confirm = action(function* (): Generator<
          Promise<"close" | "retry">,
          void,
          "close" | "retry"
        > {
          if (confirming) {
            return;
          }
          confirming = true;
          setPending(true);
          try {
            // Owner publications must not join the dialog's held transition and block navigation.
            if ((yield Promise.resolve().then(options.confirm)) === "close") {
              finish();
            }
          } finally {
            confirming = false;
          }
        });
        return (
          <SessionWorkerStopDialog
            description={options.description}
            title={options.title}
            pending={pending()}
            onCancel={cancel}
            onConfirm={() => void confirm()}
          />
        );
      });
    });
  } finally {
    stopDialogActive = false;
  }
}
