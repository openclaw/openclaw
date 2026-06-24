// Control UI component renders a copyable gateway connection command.
import { html } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";

async function copyCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    // Best effort only; the explicit copy button provides visible feedback.
  }
}

export function renderConnectCommand(command: string) {
  const copyLabel = t("overview.connection.copyCommand");
  return html`
    <div
      class="login-gate__command"
      role="button"
      tabindex="0"
      title=${copyLabel}
      aria-label=${t("overview.connection.copyCommandAria", { command })}
      @click=${async (event: Event) => {
        if ((event.target as HTMLElement | null)?.closest(".chat-copy-btn")) {
          return;
        }
        await copyCommand(command);
      }}
      @keydown=${async (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        await copyCommand(command);
      }}
    >
      <code>${command}</code>
      ${renderCopyButton(command, copyLabel)}
    </div>
  `;
}
