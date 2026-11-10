import { For } from "solid-js";

type CommandToken = { text: string; cls: "name" | "flag" | "str" | "num" | "op" | "plain" | "ws" };

const COMMAND_HIGHLIGHT_MAX_CHARS = 2_000;
const COMMAND_OP_CHARS = new Set(["|", ";", "&", "<", ">"]);

/** Small shell-ish tokenizer for display colors only; never used for execution. */
function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  let expectName = true;
  while (index < command.length) {
    const char = command.charAt(index);
    let end = index;
    let cls: CommandToken["cls"];
    if (/\s/.test(char)) {
      while (end < command.length && /\s/.test(command.charAt(end))) {
        end++;
      }
      cls = "ws";
    } else if (char === "'" || char === '"') {
      end += 1;
      while (end < command.length && command.charAt(end) !== char) {
        end += command.charAt(end) === "\\" ? 2 : 1;
      }
      end = Math.min(end + 1, command.length);
      cls = "str";
      expectName = false;
    } else if (COMMAND_OP_CHARS.has(char)) {
      while (end < command.length && COMMAND_OP_CHARS.has(command.charAt(end))) {
        end++;
      }
      cls = "op";
      expectName = true;
    } else {
      while (
        end < command.length &&
        !/\s/.test(command.charAt(end)) &&
        !COMMAND_OP_CHARS.has(command.charAt(end)) &&
        command.charAt(end) !== "'" &&
        command.charAt(end) !== '"'
      ) {
        end++;
      }
      const word = command.slice(index, end);
      cls = expectName
        ? "name"
        : word.startsWith("-")
          ? "flag"
          : /^\d+(?:[.,]\d+)?$/.test(word)
            ? "num"
            : "plain";
      expectName = false;
    }
    tokens.push({ text: command.slice(index, end), cls });
    index = end;
  }
  return tokens;
}

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
