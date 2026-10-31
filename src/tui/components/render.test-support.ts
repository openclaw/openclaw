import type { SelectItem } from "@earendil-works/pi-tui";
import { expect, vi } from "vitest";

export const attacks = [
  "\u001b[38;5;201m",
  "\u001b[3J",
  "\u001b]0;picker-title\u0007",
  "\u001b]52;c;picker-clipboard\u0007",
  "\u009b2K",
  "\u009d0;picker-c1-title\u009c",
];

export const theme = {
  selectedPrefix: (t: string) => `[${t}]`,
  selectedText: (t: string) => `**${t}**`,
  description: (t: string) => `(${t})`,
  scrollInfo: (t: string) => `~${t}~`,
  noMatch: (t: string) => `!${t}!`,
  filterLabel: (t: string) => `>${t}<`,
  searchPrompt: (t: string) => `>${t}<`,
  searchInput: (t: string) => `|${t}|`,
  matchHighlight: (t: string) => `*${t}*`,
};

export function typeText(list: { handleInput: (key: string) => void }, text: string) {
  for (const ch of text) {
    list.handleInput(ch);
  }
}

export function select(list: {
  handleInput: (key: string) => void;
  onSelect?: (item: SelectItem) => void;
}) {
  const onSelect = vi.fn<(item: SelectItem) => void>();
  list.onSelect = onSelect;
  list.handleInput("\r");
  expect(onSelect).toHaveBeenCalledTimes(1);
  return onSelect.mock.calls[0]?.[0];
}

export function expectText(text: string, present: string[], absent: string[] = []) {
  present.forEach((value) => expect(text).toContain(value));
  absent.forEach((value) => expect(text).not.toContain(value));
}
