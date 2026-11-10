/* Start By Cursor Rule, ocnply0fpxllzjz51rvkh0ej02f1skas */
/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  createReactiveDraftHarness,
  getComposerTextarea,
  inputDraftAtEnd,
  replaceSkillCommands,
} from "./chat-view.test-helpers.ts";

afterEach(() => {
  resetChatViewState();
  replaceSlashCommands(buildFallbackSlashCommands());
});

it.each(["Use `$pro`", "```text\nUse $pro\n```"])(
  "keeps a skill reference inside Markdown code as literal text: %s",
  async (draft) => {
    replaceSkillCommands({ key: "prose", description: "Draft polished prose." });
    await import("./components/chat-composer-skill-menu.tsx");
    const { container } = createReactiveDraftHarness();
    inputDraftAtEnd(container, "Use $pro");
    await waitForSolid(() => expect(container.querySelector(".skill-menu")).not.toBeNull());

    inputDraftAtEnd(container, draft);
    const textarea = getComposerTextarea(container);
    const caret = draft.indexOf("$pro") + "$pro".length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    await Promise.resolve();
    expect(container.querySelector(".skill-menu")).toBeNull();
  },
);
/* End By Cursor Rule, ocnply0fpxllzjz51rvkh0ej02f1skas */
