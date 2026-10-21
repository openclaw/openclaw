import { For } from "solid-js";
import { COMMAND_HIGHLIGHT_MAX_CHARS, tokenizeCommand } from "./chat-command-highlight.ts";

export function HighlightedCommand(props: { command: string }) {
  return (
    <>
      {props.command.length > COMMAND_HIGHLIGHT_MAX_CHARS ? (
        props.command
      ) : (
        <For each={tokenizeCommand(props.command)}>
          {(token) =>
            token.cls === "ws" || token.cls === "plain" ? (
              token.text
            ) : (
              <span class={`chat-cmd--${token.cls}`}>{token.text}</span>
            )
          }
        </For>
      )}
    </>
  );
}
