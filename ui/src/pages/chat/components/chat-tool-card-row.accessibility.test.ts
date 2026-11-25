/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getByRole, getByText, isInaccessible } from "@solidjs/testing-library";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { inlineCommandPresentation } from "../chat-inline-command-presentation.ts";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

beforeEach(() => {
  // The accessible-name algorithm uses computed display to separate child text.
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = readFileSync(
    resolve(import.meta.dirname, "../../../styles/chat/tool-cards.css"),
    "utf8",
  );
  onTestFinished(() => style.remove());
});

const webArgs = { query: "API docs" };
const webLabel = "web_search Search the web for “API docs”";
const rows = [
  ["web_search", webArgs, false, webLabel],
  ["tool_call", { id: "web_search", args: webArgs }, true, webLabel],
  // jsdom joins the inline verb and target; their flex gap is not a text node.
  ["grep", { pattern: "release" }, true, "grep Searchrelease"],
] as const;

it.each(rows)(
  "includes the outcome once in the focused %s disclosure's accessible name",
  async (name, args, inline, label) => {
    const container = document.createElement("div");
    const inlineCommands = inline ? await inlineCommandPresentation() : undefined;
    const end = { itemId: "search", kind: "tool", title: "Search", phase: "end" } as const;
    for (const [activity, outcome] of [
      [{ ...end, status: "blocked" }, "Blocked"],
      [end, "Outcome unknown"],
      [undefined, "No result recorded"],
    ] as const) {
      await mountCard(
        { id: name, name, args, activity },
        { expanded: false, inlineCommands, interrupted: Boolean(activity) },
        container,
      );
      const button = getByRole(container, "button", {
        name: `${label} ${outcome}`,
        description: "",
        expanded: false,
      });
      expect(button).toBe(container.querySelector("button.chat-tool-row"));
      expect(getComputedStyle(button).display).toBe("inline-flex");
      expect(container.querySelector(".chat-tool-row__toggle")).toBeNull();
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  },
);

it.each(rows)(
  "retains one visible cause when opening an interrupted %s disclosure",
  async (name, args, inline, label) => {
    const card = { id: name, name, args };
    const options = {
      interrupted: true,
      inlineCommands: inline ? await inlineCommandPresentation() : undefined,
      onToggleExpanded: vi.fn(),
    };
    const container = await mountCard(card, { ...options, expanded: false });
    const accessible = { name: `${label} interrupted`, description: "" };
    const button = getByRole(container, "button", { ...accessible, expanded: false });
    button.focus();
    button.click();
    expect(options.onToggleExpanded).toHaveBeenCalledWith(name);
    await mountCard(card, { ...options, expanded: true }, container);
    expect(isInaccessible(getByText(container, "interrupted"))).toBe(false);
    expect(getByRole(container, "button", { ...accessible, expanded: true })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe(
      "No result available.",
    );
  },
);
