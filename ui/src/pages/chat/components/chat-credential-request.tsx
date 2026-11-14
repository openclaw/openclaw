import { createUniqueId, For } from "solid-js";
import { AgentRowChip } from "../../../components/agent-row-chip.tsx";
import { iconButtonClass } from "../../../components/solid/icon-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover } from "../../../components/solid/popover.tsx";
import { registerChatQuestionsEnglish } from "../../../i18n/locales/en-chat-questions.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatQuestionsEnglish);

export function CredentialRequestIdentity(props: { agentId?: string }) {
  return (
    <div class="chat-question-panel__request">
      <For each={t("chat.questions.storeRequest").split("{agent}")}>
        {(part, index) => (
          <>
            {index() > 0 && <AgentRowChip agentId={props.agentId} />}
            <span>{part}</span>
          </>
        )}
      </For>
    </div>
  );
}

export function CredentialRequestDetails() {
  return (
    <Popover
      id={createUniqueId()}
      label={t("chat.questions.storeDetails")}
      trigger={<Icon name="info" />}
      triggerClass={iconButtonClass({ size: 28 })}
      class="chat-question-panel__store"
      placement="top-end"
    >
      <p>{t("chat.questions.storePrivacy")}</p>
      <p>{t("chat.questions.storeHostsHint")}</p>
    </Popover>
  );
}
