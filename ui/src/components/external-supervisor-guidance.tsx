import { Show } from "solid-js";
import type { ExternalSupervisorGuidance as Guidance } from "../api/types.ts";
import { t } from "../lib/reactive/i18n.ts";
import { CopyButton } from "./solid/copy-button.tsx";

type Props = { guidance: Guidance | null };

export function ExternalSupervisorGuidance(props: Props) {
  return (
    <Show when={props.guidance} keyed>
      {(guidance) => (
        <div class="external-supervisor-guidance">
          <p>{t("updates.externalSupervisor.managedBy", { name: guidance.name })}</p>
          <Show when={guidance.runFrom} keyed>
            {(location) => <p>{t("updates.externalSupervisor.runFrom", { location })}</p>}
          </Show>
          <div class="exec-approval-command mono">
            <code translate="no">{guidance.command}</code>
            <CopyButton
              text={guidance.command}
              idleLabel={t("updates.externalSupervisor.copyCommand")}
            />
          </div>
        </div>
      )}
    </Show>
  );
}
