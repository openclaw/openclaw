import type { JSX } from "@solidjs/web";
import {
  Errored,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  isPending,
} from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type AgentConfigActions = {
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  canUpdateConfig: boolean;
  presentationRetired: Promise<void>;
  onConfigReload: () => Promise<unknown>;
  onConfigSave: () => Promise<unknown>;
};

type ConfigCommand = {
  operation: "save" | "reload";
  completion: Promise<unknown>;
  retired: Promise<void>;
};

export function AgentConfigButtons(
  props: AgentConfigActions & { children?: JSX.Element; buttonType?: "button" },
) {
  const [saving, setSaving] = createOptimistic(false);
  const [command, setCommand] = createSignal<ConfigCommand | null>(null);
  const completed = createMemo(() => command()?.completion.then(() => null) ?? null);
  const present = action(function* (receipt: ConfigCommand) {
    if (receipt.retired === props.presentationRetired) {
      setSaving(true);
    }
    yield receipt.completion;
  });
  const submit = (operation: "save" | "reload") => {
    const retired = props.presentationRetired;
    const ownerCompletion = operation === "save" ? props.onConfigSave() : props.onConfigReload();
    const receipt = { operation, completion: Promise.race([ownerCompletion, retired]), retired };
    setCommand(receipt);
    // Reload can publish its editor lock after draining writes; keep that read
    // outside the write action so the lock reaches the form while it is pending.
    if (operation === "save") {
      // Let the owner's publication land without waiting for its async reads.
      void Promise.resolve()
        .then(() => present(receipt))
        .catch(() => undefined);
    }
  };
  const currentCommand = () => {
    const receipt = command();
    return receipt?.retired === props.presentationRetired ? receipt : null;
  };
  const reloading = () => isPending(completed) && currentCommand()?.operation === "reload";
  const busy = () => saving() || reloading();
  return (
    <>
      <button
        type={props.buttonType}
        class="btn btn--sm"
        disabled={busy() || props.configLoading}
        aria-busy={reloading() || props.configLoading ? "true" : "false"}
        onClick={() => submit("reload")}
      >
        {t("common.reloadConfig")}
      </button>
      {props.children}
      <button
        type={props.buttonType}
        class="btn btn--sm primary"
        disabled={busy() || !props.canUpdateConfig || props.configSaving || !props.configDirty}
        aria-busy={saving() || props.configSaving ? "true" : "false"}
        onClick={() => submit("save")}
      >
        {t(saving() || props.configSaving ? "common.saving" : "common.save")}
      </button>
      <Show when={currentCommand()} keyed>
        {(_receipt) => (
          <Errored
            fallback={(error) => (
              <div class="callout danger" role="alert">
                {formatUiError(error())}
              </div>
            )}
          >
            <Loading fallback={null}>{completed()}</Loading>
          </Errored>
        )}
      </Show>
    </>
  );
}
