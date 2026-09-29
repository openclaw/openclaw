// Interactive question input keeps answer drafts out of the chat composer and history.
import {
  CURSOR_MARKER,
  Input,
  Key,
  Text,
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { QuestionAnswers, QuestionRecord } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { hasTerminalControl } from "../../../packages/terminal-core/src/safe-text.js";
import { tuiTheme as theme } from "../theme/theme.js";
import { sanitizeRenderableLine } from "../tui-formatters.js";

function safeText(value: string): string {
  return sanitizeRenderableLine(
    value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ""),
  );
}

/** A secret editor has no undo/kill ring and never passes its value to a renderer. */
class MaskedQuestionInput {
  private characters: string[] = [];
  private cursor = 0;

  getValue(): string {
    return this.characters.join("");
  }

  clear(): void {
    this.characters = [];
    this.cursor = 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        this.characters.splice(--this.cursor, 1);
      }
    } else if (matchesKey(data, Key.delete)) {
      this.characters.splice(this.cursor, 1);
    } else if (matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (matchesKey(data, Key.right)) {
      this.cursor = Math.min(this.characters.length, this.cursor + 1);
    } else if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) {
      this.cursor = 0;
    } else if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) {
      this.cursor = this.characters.length;
    } else if (matchesKey(data, Key.ctrl("u"))) {
      this.characters.splice(0, this.cursor);
      this.cursor = 0;
    } else if (matchesKey(data, Key.ctrl("k"))) {
      this.characters.splice(this.cursor);
    } else {
      const printable = decodeKittyPrintable(data) ?? data;
      if (!hasTerminalControl(printable)) {
        this.insert(printable);
      }
    }
  }

  insert(value: string): void {
    const characters = Array.from(value);
    this.characters.splice(this.cursor, 0, ...characters);
    this.cursor += characters.length;
  }

  render(width: number, focused: boolean): string[] {
    const available = Math.max(1, width - 3);
    const start = Math.max(0, this.cursor - available + 1);
    const before = "•".repeat(this.cursor - start);
    const after = "•".repeat(
      Math.min(this.characters.length - this.cursor, available - before.length),
    );
    return [`> ${before}${focused ? CURSOR_MARKER : ""}${after}`];
  }
}

type QuestionPromptActions = {
  onSubmit: (answers: QuestionAnswers) => void;
  onSkip: () => void;
  onCollapse: () => void;
  requestRender: () => void;
};
type PromptRow =
  | { kind: "option"; index: number; label: string }
  | { kind: "other" | "confirm" | "skip" | "back"; label: string };

/** One step at a time, with a separate masked editor for secret answers. */
export class QuestionPrompt implements Component, Focusable {
  focused = false;
  private step = 0;
  private selectedRow = 0;
  private editing = false;
  private closed = false;
  private message = "";
  private pasteBuffer: string | null = null;
  private rejectedSecretPaste = false;
  private readonly answers: Record<string, string[]> = {};
  private readonly selections = new Map<number, Set<number>>();
  private readonly freeText = new Map<number, string>();
  private input = new Input();
  private readonly secretInput = new MaskedQuestionInput();

  constructor(
    private readonly record: QuestionRecord,
    private readonly actions: QuestionPromptActions,
  ) {
    this.enterStep();
  }

  private get question() {
    return expectDefined(this.record.questions[this.step], "active question step");
  }

  private rows(): PromptRow[] {
    return [
      ...this.question.options.map((option, index) => ({
        kind: "option" as const,
        index,
        label: `${index + 1}. ${safeText(option.label)}`,
      })),
      { kind: "other", label: `${this.question.options.length + 1}. Other…` },
      {
        kind: "confirm",
        label: this.step < this.record.questions.length - 1 ? "Next" : "Confirm answer",
      },
      { kind: "skip", label: "Skip" },
      ...(this.step > 0 ? [{ kind: "back" as const, label: "Back" }] : []),
    ];
  }

  private enterStep(): void {
    this.input = new Input();
    this.secretInput.clear();
    const draft = this.freeText.get(this.step) ?? "";
    if (this.question.isSecret) {
      this.secretInput.insert(draft);
    } else {
      this.input.setValue(draft);
    }
    this.selectedRow = this.selections.get(this.step)?.values().next().value ?? 0;
    this.editing = this.question.options.length === 0;
    this.message = "";
    this.rejectedSecretPaste = false;
  }

  private draft(): string {
    return this.question.isSecret ? this.secretInput.getValue() : this.input.getValue();
  }

  private saveDraft(): void {
    this.freeText.set(this.step, this.draft());
  }

  private toggle(index: number): void {
    const selected = this.selections.get(this.step) ?? new Set<number>();
    if (selected.has(index)) {
      selected.delete(index);
    } else {
      selected.add(index);
    }
    this.selections.set(this.step, selected);
  }

  private advance(singleOption?: number): void {
    if (this.rejectedSecretPaste) {
      this.message =
        "Secret paste contains line breaks or unsupported control characters. Enter a single-line value.";
      return;
    }
    this.saveDraft();
    const question = this.question;
    const selected =
      singleOption === undefined ? this.selections.get(this.step) : new Set([singleOption]);
    const values = question.options
      .filter((_, index) => selected?.has(index))
      .map((option) => option.label);
    const value = this.draft();
    if (singleOption === undefined && (question.isSecret ? value.length > 0 : value.trim())) {
      values.push(question.isSecret ? value : value.trim());
    }
    if (values.length === 0) {
      this.message = "Choose an option or enter an answer.";
      return;
    }
    if (singleOption !== undefined) {
      this.selections.set(this.step, new Set([singleOption]));
      this.freeText.delete(this.step);
    }
    this.answers[question.questionId] = values;
    if (this.step < this.record.questions.length - 1) {
      this.step += 1;
      this.enterStep();
      return;
    }
    this.actions.onSubmit({ answers: { ...this.answers } });
  }

  private activate(): void {
    const row = this.rows()[this.selectedRow];
    if (!row) {
      return;
    }
    if (row.kind === "option") {
      if (this.question.multiSelect) {
        this.toggle(row.index);
      } else {
        this.advance(row.index);
      }
    } else if (row.kind === "other") {
      if (!this.question.multiSelect) {
        this.selections.delete(this.step);
      }
      this.editing = true;
    } else if (row.kind === "confirm") {
      this.advance();
    } else if (row.kind === "skip") {
      this.actions.onSkip();
    } else {
      this.saveDraft();
      this.step -= 1;
      this.enterStep();
    }
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) {
      return;
    }
    // A paste may arrive in several terminal reads. Its newlines and escape bytes
    // are text, never submit/collapse shortcuts.
    if (this.editing && (this.pasteBuffer !== null || data.includes("\x1b[200~"))) {
      this.pasteBuffer = (this.pasteBuffer ?? "") + data.replace("\x1b[200~", "");
      const end = this.pasteBuffer.indexOf("\x1b[201~");
      if (end >= 0) {
        const paste = this.pasteBuffer.slice(0, end);
        const remaining = this.pasteBuffer.slice(end + 6);
        this.pasteBuffer = null;
        if (this.question.isSecret) {
          this.rejectedSecretPaste =
            hasTerminalControl(paste.replaceAll("\t", "")) || /[\u2028\u2029]/.test(paste);
          if (this.rejectedSecretPaste) {
            this.message =
              "Secret paste contains line breaks or unsupported control characters. Enter a single-line value.";
          } else {
            this.message = "";
            this.secretInput.insert(paste);
          }
        } else {
          this.input.handleInput(`\x1b[200~${paste}\x1b[201~`);
        }
        if (remaining) {
          this.handleInput(remaining);
        }
      }
      this.actions.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.saveDraft();
      this.actions.onCollapse();
      return;
    }
    this.message = "";
    if (this.editing) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.saveDraft();
        this.editing = false;
        this.selectedRow = this.question.options.length + 1;
      } else if (matchesKey(data, Key.enter) || data === "\n") {
        this.advance();
      } else if (this.question.isSecret) {
        this.secretInput.handleInput(data);
        const printable = decodeKittyPrintable(data) ?? data;
        if (
          !hasTerminalControl(printable) ||
          matchesKey(data, Key.backspace) ||
          matchesKey(data, Key.delete)
        ) {
          this.rejectedSecretPaste = false;
        }
      } else {
        this.input.handleInput(data);
      }
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
      this.selectedRow = (this.selectedRow + this.rows().length - 1) % this.rows().length;
    } else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.selectedRow = (this.selectedRow + 1) % this.rows().length;
    } else if (matchesKey(data, Key.enter) || data === "\n") {
      this.activate();
    } else if (matchesKey(data, Key.space)) {
      const row = this.rows()[this.selectedRow];
      if (row?.kind === "option" && this.question.multiSelect) {
        this.toggle(row.index);
      }
    } else {
      const printable = decodeKittyPrintable(data) ?? data;
      if (/^[1-5]$/.test(printable)) {
        const index = Number(printable) - 1;
        if (index <= this.question.options.length) {
          this.selectedRow = index;
          if (index === this.question.options.length) {
            this.activate();
          } else if (this.question.multiSelect) {
            this.toggle(index);
          }
        }
      }
    }
    this.actions.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    if (this.closed) {
      return [];
    }
    const question = this.question;
    const seconds = Math.max(0, Math.ceil((this.record.expiresAtMs - Date.now()) / 1_000));
    const lines = [
      theme.header(
        `Question ${this.step + 1}/${this.record.questions.length} · ${safeText(question.header)}`,
      ),
      safeText(question.question),
      theme.dim(`Expires in ${seconds}s`),
    ];
    const binding = question.secretStore;
    if (binding) {
      lines.push(`Secret store entry: ${safeText(binding.name)}`);
      if (binding.reason) {
        lines.push(`Reason: ${safeText(binding.reason)}`);
      }
      lines.push(
        `Allowed hosts (accept as proposed): ${binding.allowedHosts?.map(safeText).join(", ") || "none"}`,
      );
      if (question.secretStoreExisting) {
        lines.push(theme.accent("An existing value will be replaced."));
      }
    }
    const rendered = new Text(lines.join("\n"), 0, 0).render(width);
    for (const [index, row] of this.rows().entries()) {
      const selected = !this.editing && index === this.selectedRow;
      const checked = row.kind === "option" && this.selections.get(this.step)?.has(row.index);
      const marker =
        row.kind === "option" && question.multiSelect ? `[${checked ? "x" : " "}] ` : "";
      rendered.push(
        ...new Text(
          (selected ? theme.accent : theme.fg)(`${selected ? "›" : " "} ${marker}${row.label}`),
          0,
          0,
        ).render(width),
      );
      if (row.kind === "option") {
        const description = question.options[row.index]?.description;
        if (description) {
          rendered.push(...new Text(theme.dim(`    ${safeText(description)}`), 0, 0).render(width));
        }
      }
      if (row.kind === "other" && (this.editing || this.draft())) {
        this.input.focused = this.focused && this.editing;
        rendered.push(
          ...(question.isSecret
            ? this.secretInput.render(width, this.focused && this.editing)
            : this.input.render(width)),
        );
      }
    }
    rendered.push(
      ...new Text(
        theme.dim(
          this.editing
            ? "Enter next/submit · Tab choices · Esc collapse"
            : `↑/↓ or numbers select${question.multiSelect ? " · Space toggles" : ""} · Enter confirm · Esc collapse`,
        ),
        0,
        0,
      ).render(width),
    );
    if (question.isSecret) {
      rendered.push(
        ...new Text(
          theme.dim("Masked entry · Answer through this prompt, not the composer."),
          0,
          0,
        ).render(width),
      );
    }
    if (this.message) {
      rendered.push(...new Text(theme.error(this.message), 0, 0).render(width));
    }
    return rendered;
  }

  dispose(): void {
    this.closed = true;
    this.pasteBuffer = null;
    this.input = new Input();
    this.secretInput.clear();
    this.freeText.clear();
    this.selections.clear();
    for (const key of Object.keys(this.answers)) {
      delete this.answers[key];
    }
  }
}
