import type { JSX } from "@solidjs/web";
import { getSlashCommandDescription, type SlashCommandDef } from "../../../lib/chat/commands.ts";
import { paneDomId } from "./chat-composer-dom.ts";

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

export function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

export function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

export function renderSlashMatchedName(name: string, query: string): JSX.Element {
  const matchLength = name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return matchLength === 0 ? (
    <>{name}</>
  ) : (
    <>
      <mark>{name.slice(0, matchLength)}</mark>
      {name.slice(matchLength)}
    </>
  );
}

export function getSlashCommandOptionLabel(cmd: SlashCommandDef | undefined): string {
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}
