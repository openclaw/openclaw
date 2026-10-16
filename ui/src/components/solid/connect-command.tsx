import { t } from "../../lib/reactive/i18n.ts";
import { CopyButton } from "./copy-button.tsx";
import "../tooltip.ts";

function copyCommand(target: HTMLElement) {
  target.querySelector<HTMLButtonElement>(".chat-copy-btn")?.click();
}

export function ConnectCommand(props: { command: string; variant?: "inline" | "hero" }) {
  const copyLabel = () => t("connection.help.copyCommand");
  return (
    <openclaw-tooltip prop:content={copyLabel()}>
      <div
        class={["login-gate__command", { "login-gate__command--hero": props.variant === "hero" }]}
        role="button"
        tabindex={0}
        aria-label={t("connection.help.copyCommandAria", { command: props.command })}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest(".chat-copy-btn")) {
            return;
          }
          copyCommand(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          copyCommand(event.currentTarget);
        }}
      >
        <code translate="no">{props.command}</code>
        <CopyButton text={props.command} idleLabel={copyLabel()} />
      </div>
    </openclaw-tooltip>
  );
}
