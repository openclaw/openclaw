import { redo, undo } from "@codemirror/commands";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { readComposerSkillReferences } from "../../lib/chat/skill-references.ts";
import {
  focusComposerInput,
  readComposerEditor,
  selectComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import { createReferenceComposerBinding } from "../../lib/reactive/composer-editor.ts";
import "../../test-helpers/load-styles.ts";
import { composerSkillExtension } from "./components/composer-editor-skills.ts";

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
  let mentions: readonly HumanMention[] = person
    ? [{ profileId: "alex-one", start: 0, end: 5 }]
    : [];
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

it.each(["$clawhub ", "`code` $clawhub prose ", "~~~\ncode\n~~~\n\n$clawhub prose "])(
  "retains skill DOM without rescanning ordinary edits in %s",
  async (prefix) => {
    const f = fixture(prefix);
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
    const scans = vi.spyOn(String.prototype, "matchAll");
    let skillScans: number;
    try {
      await userEvent.keyboard("Look for a useful skill.");
      skillScans = scans.mock.calls.filter(([pattern]) =>
        String(pattern).startsWith("/\\$"),
      ).length;
    } finally {
      scans.mockRestore();
    }
    await vi.waitFor(() => expect(f.input.value).toBe(prefix + "Look for a useful skill."));
    expect(skillScans).toBe(0);
    expect(f.chip()).toBe(chip);
    expect(echoes).toBe(0);
  },
);

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
    expect(f.input.selectionStart).toBe(f.input.value.length);
    await userEvent.keyboard("{ArrowLeft}".repeat("$clawhub".length));
    await expect.poll(() => f.chip()?.textContent).toBe("ClawHub");
    if (!rich) {
      expect(undo(f.view())).toBe(true);
      expect(f.input.value).toBe("Use $clawhu");
      expect(redo(f.view())).toBe(true);
      expect(f.input.value).toBe("Use $clawhub");
    }
  },
);

it("uses canonical skill identity before normalized command names, never display labels", async () => {
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
  expect(readComposerSkillReferences("$Hyphen-skill $Underscore-skill")).toEqual([]);
});

it("reconciles unchanged native and rich drafts when the catalog arrives, renames or removes a skill", async () => {
  const f = fixture("Use $later now");
  const catalog = (label: string) => [
    {
      key: "later",
      name: "later",
      description: "Skill",
      source: "skill" as const,
      skillReferenceable: true,
      skillDisplayName: label,
    },
  ];
  // Let the initial unknown-reference admission finish before catalog arrival.
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  expect(readComposerEditor(f.input)).toBeUndefined();
  replaceSlashCommands(catalog("First label"));
  await expect.poll(() => f.chip()?.textContent).toBe("First label");
  const view = f.view();
  selectComposerInput(f.input, 0, 3);
  replaceSlashCommands(catalog("Renamed label"));
  await expect.poll(() => f.chip()?.textContent).toBe("Renamed label");
  replaceSlashCommands([]);
  await expect.poll(f.chip).toBeNull();
  expect(f.view()).toBe(view);
  expect(f.input.value).toBe("Use $later now");
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([0, 3]);
});

it("keeps single-line prose edits local and reparses combined indentation", async () => {
  const f = fixture("$clawhub ");
  await expect.poll(f.chip).not.toBeNull();
  // Count this extension, not the host's required raw-value publication.
  const state = EditorState.create({
    doc: "$clawhub " + "a".repeat(65_536),
    extensions: composerSkillExtension(f.input),
  });
  const doc = state.doc;
  const read = vi.spyOn(doc, "sliceString");
  try {
    expect(
      state.update({ changes: { from: doc.length, insert: "x" }, userEvent: "input.type" }).state
        .doc.length,
    ).toBe(doc.length + 1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(8);
    expect(read.mock.calls.every(([from, to]) => (to ?? doc.length) - from < 100)).toBe(true);
  } finally {
    read.mockRestore();
  }
  f.input.value = "Intro\n\n  $clawhub";
  syncComposerInput(f.input);
  await expect.poll(() => f.view().state.doc.toString()).toBe("Intro\n\n  $clawhub");
  expect(f.chip()).not.toBeNull();
  f.view().dispatch({
    changes: [
      { from: 7, insert: " " },
      { from: 8, insert: " " },
    ],
  });
  expect(f.input.value).toBe("Intro\n\n    $clawhub");
  expect(f.chip()).toBeNull();
});

it("matches canonical skill parsing after structural and ordinary owner edits", () => {
  const f = fixture("");
  const documents = [
    "Intro $clawhub after",
    "$clawhub" + ":".repeat(64),
    "\\ $clawhub",
    "Intro \u0060x\u0060 $clawhub \u0060\u0060tail\u0060\u0060",
    "Intro\n\n    $clawhub\n\nAfter $clawhub",
    "~~~ js\n$clawhub\n~~~\n$clawhub",
    "1. \u0060code\n   $clawhub\u0060\n$clawhub",
    "Intro \u0060code\n=====\n$clawhub\u0060",
    "Intro \u0060code\n_____\n$clawhub\u0060",
    "a | b\n:--- | ---:\n$clawhub | \u0060code\u0060",
    "![\u0060$clawhub\u0060][label]\n\n[label]: /asset\n$clawhub",
    "/say $clawhub",
  ];
  const insertions = ["x", " ", "", "\n", "\u0060", "[", "\\", "$clawhub", "   "];
  for (const document of documents) {
    const initial = EditorState.create({
      doc: document,
      extensions: composerSkillExtension(f.input),
    });
    for (let offset = 0; offset <= document.length; offset++) {
      for (const insert of insertions) {
        const state = initial.update({
          changes: {
            from: offset,
            to: Math.min(document.length, offset + (offset % 3)),
            insert,
          },
          userEvent: "input.complete",
        }).state;
        const actual: Array<[number, number]> = [];
        for (const ranges of state.facet(EditorView.decorations)) {
          if (typeof ranges === "function") {
            throw new Error("Skill decorations must be state-owned");
          }
          ranges.between(0, state.doc.length, (from, to) => {
            actual.push([from, to]);
          });
        }
        expect(actual, JSON.stringify({ document, offset, insert })).toEqual(
          readComposerSkillReferences(state.doc.toString()).map(({ start, end }) => [start, end]),
        );
      }
    }
  }
});
