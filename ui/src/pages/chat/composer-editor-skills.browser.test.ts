import { redo, undo } from "@codemirror/commands";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  focusComposerInput,
  readComposerEditor,
  selectComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import { createReferenceComposerBinding } from "../../lib/reactive/composer-editor.ts";
import "../../test-helpers/load-styles.ts";

function fixture(value: string, person = false) {
  replaceSlashCommands([
    {
      key: "clawhub",
      name: "clawhub",
      description: "Find skills",
      source: "skill",
      skillReferenceable: true,
      skillDisplayName: "ClawHub",
    },
  ]);
  const surface = document.createElement("div");
  const input = document.createElement("textarea");
  input.value = value;
  surface.append(input);
  document.body.append(surface);
  let raw = value;
  let mentions = person ? [{ profileId: "alex-one", start: 0, end: 5 }] : [];
  input.addEventListener("input", () => {
    mentions = updateHumanMentions(raw, input.value, mentions) ?? [];
    raw = input.value;
    syncComposerInput(input);
  });
  const binding = createRoot((dispose) => ({
    ref: createReferenceComposerBinding(() => mentions),
    dispose,
  }));
  binding.ref(input);
  onTestFinished(() => {
    binding.dispose();
    surface.remove();
  });
  return {
    input,
    surface,
    chip: () => surface.querySelector(".chat-composer-skill"),
    view: () => EditorView.findFromDOM(readComposerEditor(input)!.focusElement)!,
  };
}
afterEach(() => replaceSlashCommands(buildFallbackSlashCommands()));

it("uses atomic selection, deletion, undo, clipboard text and boundary typing for skill names", async () => {
  const f = fixture("@Alex use $clawhub now", true);
  await expect.poll(f.chip).not.toBeNull();
  expect(f.chip()!.textContent).toBe("ClawHub");
  expect(f.chip()!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  focusComposerInput(f.input);
  selectComposerInput(f.input, 12, 12);
  expect([10, 18]).toContain(f.input.selectionStart);
  selectComposerInput(f.input, 10, 18);
  expect(
    f.view().state.sliceDoc(f.view().state.selection.main.from, f.view().state.selection.main.to),
  ).toBe("$clawhub");
  const clipboard = new DataTransfer();
  f.view().contentDOM.dispatchEvent(
    new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }),
  );
  expect(clipboard.getData("text/plain")).toBe("$clawhub");
  await userEvent.keyboard("{Backspace}");
  expect(f.input.value).toBe("@Alex use  now");
  expect(f.chip()).toBeNull();
  expect(undo(f.view())).toBe(true);
  expect(f.chip()!.textContent).toBe("ClawHub");
  expect(redo(f.view())).toBe(true);
  expect(f.chip()).toBeNull();
  undo(f.view());
  selectComposerInput(f.input, 18, 18);
  await userEvent.keyboard("please");
  expect(f.input.value).toBe("@Alex use $clawhub please now");
  expect(f.chip()!.textContent).toBe("ClawHub");
  expect(f.surface.querySelector(".chat-composer-mention")?.textContent).toContain("Alex");
});

it("keeps plain typing native, then activates on a completed or pasted known skill", async () => {
  const f = fixture("");
  focusComposerInput(f.input);
  await userEvent.keyboard("Use $clawhub");
  expect(readComposerEditor(f.input)).toBeUndefined();
  await userEvent.keyboard(" ");
  await expect.poll(f.chip).not.toBeNull();
  expect(f.input.value).toBe("Use $clawhub ");
  const pasted = fixture("");
  focusComposerInput(pasted.input);
  pasted.input.value = "$clawhub";
  pasted.input.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }),
  );
  await expect.poll(pasted.chip).not.toBeNull();
  expect(undo(pasted.view())).toBe(true);
  expect(pasted.input.value).toBe("");
  expect(redo(pasted.view())).toBe(true);
  expect(pasted.chip()?.textContent).toBe("ClawHub");
});

it("leaves code, escaped dollars, shell variables and unknown skills literal", async () => {
  const f = fixture(
    "$HOME $unknown \\$clawhub \u0060$clawhub\u0060\n\u0060\u0060\u0060\n$clawhub\n\u0060\u0060\u0060",
  );
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  expect(readComposerEditor(f.input)).toBeUndefined();
  f.input.value += "\n$clawhub ";
  syncComposerInput(f.input);
  await expect.poll(f.chip).not.toBeNull();
  expect(f.surface.querySelectorAll(".chat-composer-skill")).toHaveLength(1);
});

it("retains skill DOM and performs no reconciliation transaction on owner echoes", async () => {
  const f = fixture("$clawhub ");
  await expect.poll(f.chip).not.toBeNull();
  const chip = f.chip();
  let echoes = 0;
  f.view().dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        echoes += update.transactions.filter(
          (transaction) => !transaction.docChanged && transaction.isUserEvent("input.complete"),
        ).length;
      }),
    ),
  });
  focusComposerInput(f.input);
  selectComposerInput(f.input, f.input.value.length, f.input.value.length);
  await userEvent.keyboard("Look for a useful skill.");
  await vi.waitFor(() => expect(f.input.value).toBe("$clawhub Look for a useful skill."));
  expect(f.chip()).toBe(chip);
  expect(echoes).toBe(0);
});

it.each([false, true])(
  "highlights a completed typed skill when the caret leaves it (rich=%s)",
  async (rich) => {
    const f = fixture(rich ? "@Alex " : "", rich);
    if (rich) {
      await expect.poll(() => readComposerEditor(f.input)).toBeDefined();
    }
    focusComposerInput(f.input);
    selectComposerInput(f.input, f.input.value.length, f.input.value.length);
    await userEvent.keyboard("Use $clawhub");
    expect(f.chip()).toBeNull();
    await userEvent.keyboard("{Home}");
    await expect.poll(() => f.chip()?.textContent).toBe("ClawHub");
    if (!rich) {
      expect(undo(f.view())).toBe(true);
      expect(f.input.value).toBe("Use $clawhu");
      expect(redo(f.view())).toBe(true);
      expect(f.input.value).toBe("Use $clawhub");
    }
  },
);

it("uses canonical skill identity before normalized names or display aliases", async () => {
  const f = fixture("");
  replaceSlashCommands(
    [
      ["alias_owner", "foo_bar"],
      ["foo-bar", "Hyphen skill"],
      ["foo_bar", "Underscore skill"],
    ].map(([name, skillDisplayName]) => ({
      key: name!,
      name: name!,
      skillDisplayName,
      description: "Skill",
      source: "skill",
      skillReferenceable: true,
    })),
  );
  f.input.value = "$foo-bar $foo_bar ";
  syncComposerInput(f.input);
  await expect
    .poll(() =>
      [...f.surface.querySelectorAll(".chat-composer-skill")].map((node) => node.textContent),
    )
    .toEqual(["Hyphen skill", "Underscore skill"]);
  expect(f.input.value).toBe("$foo-bar $foo_bar ");
});
