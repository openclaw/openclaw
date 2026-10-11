import { Show } from "solid-js";
import type { ExternalSupervisorGuidance as Guidance } from "../api/types.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { CopyButton } from "./solid/copy-button.tsx";

type Props = { guidance: Guidance | null };

export const ExternalSupervisorGuidance = defineSolidBridge<Props>(
  "openclaw-external-supervisor-guidance",
  (props) => (
    <Show when={props.guidance} keyed>
      {(guidance) => (
        <>
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
        </>
      )}
    </Show>
  ),
  {
    properties: {
      guidance: { default: null, attribute: false },
    },
  },
);
