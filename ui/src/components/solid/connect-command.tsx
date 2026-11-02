import { t } from "../../lib/reactive/i18n.ts";
import { CopyButton } from "./copy-button.tsx";
import "../tooltip.ts";

export function ConnectCommand(props: { command: string; variant?: "inline" | "hero" }) {
  const copyLabel = () => t("connection.help.copyCommand");
  let copyButton: HTMLButtonElement;
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
          copyButton.click();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          copyButton.click();
        }}
      >
        <code translate="no">{props.command}</code>
        <CopyButton
          ref={(element) => (copyButton = element)}
          text={props.command}
          idleLabel={copyLabel()}
        />
      </div>
    </openclaw-tooltip>
  );
}
