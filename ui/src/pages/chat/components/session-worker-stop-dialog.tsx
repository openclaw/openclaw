import { action, createOptimistic, Show } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerSessionMachineEnglish } from "../../../i18n/locales/en-session-machine.ts";
import "./session-worker-stop-dialog.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerSessionMachineEnglish);

type SessionWorkerStopDialogProps = {
  description: string;
  machineName?: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => boolean;
};

/** The placement owner retains the captured identity and performs the effect. */
function SessionWorkerStopDialog(props: SessionWorkerStopDialogProps) {
  let cancelButton!: HTMLButtonElement;
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => cancelButton}
      class="session-worker-stop-dialog"
      label={t("sessionsView.workerStopTitle")}
      onModal-cancel={(event) => {
        if (!props.onCancel()) {
          event.preventDefault();
        }
      }}
    >
      <section class="session-worker-stop">
        <header class="session-worker-stop__heading">
          <h2>{t("sessionsView.workerStopTitle")}</h2>
          <button
            type="button"
            class="session-worker-stop__close"
            aria-label={t("common.close")}
            disabled={props.pending}
            onClick={() => props.onCancel()}
          >
            <Icon name="x" />
          </button>
        </header>
        <p class="session-worker-stop__description">
          {props.description}
          <Show when={props.machineName}>
            {(name) => (
              <>
                {" "}
                <strong>{name()}</strong>.
              </>
            )}
          </Show>{" "}
          {t("sessionsView.workerStopContinue")}
        </p>
        <openclaw-modal-actions class="exec-approval-actions session-worker-stop__actions">
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
              <span class="session-worker-stop__spinner" />
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
  machineName?: string;
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
            machineName={options.machineName}
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
