import type { SelectItem } from "@earendil-works/pi-tui";
import { expect, vi } from "vitest";

export const selectTheme = {
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

export function typeInput(list: { handleInput: (key: string) => void }, text: string) {
  for (const ch of text) {
    list.handleInput(ch);
  }
}

export function selectByEnter(list: {
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
