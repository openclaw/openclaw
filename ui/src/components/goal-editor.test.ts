/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGoal } from "../api/types.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import type { GoalEditor } from "./goal-editor.ts";
import "./goal-editor.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

const ACTIVE_GOAL: SessionGoal = {
  schemaVersion: 1,
  id: "goal-1",
  objective: "Finish the migration",
  status: "active",
  createdAt: 0,
  updatedAt: 0,
  tokenStart: 0,
  tokensUsed: 0,
  tokenBudget: 5000,
  continuationTurns: 0,
};

async function renderEditor(handlers: {
  goal?: SessionGoal | null;
  onSubmit?: (command: string) => void;
  onClose?: () => void;
}): Promise<GoalEditor> {
  render(
    html`
      <openclaw-goal-editor
        .props=${{
          goal: handlers.goal ?? null,
          onSubmit: handlers.onSubmit ?? (() => undefined),
          onClose: handlers.onClose ?? (() => undefined),
        }}
      ></openclaw-goal-editor>
    `,
    container,
  );
  const editor = container.querySelector("openclaw-goal-editor") as GoalEditor;
  await editor.updateComplete;
  return editor;
}

describe("openclaw-goal-editor", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
    vi.restoreAllMocks();
  });

  it("creates a goal via /goal set with an objective and budget", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const editor = await renderEditor({ goal: null, onSubmit, onClose });

    const objective = container.querySelector<HTMLTextAreaElement>(".goal-dialog-objective")!;
    objective.value = "Ship the parity UI";
    objective.dispatchEvent(new Event("input"));
    const budget = container.querySelector<HTMLInputElement>(".goal-dialog-budget")!;
    budget.value = "1200";
    budget.dispatchEvent(new Event("input"));
    await editor.updateComplete;

    container.querySelector<HTMLButtonElement>("[data-goal-editor-save]")!.click();
    expect(onSubmit).toHaveBeenCalledWith("/goal set Ship the parity UI --budget 1200");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("edits an active goal via /goal edit and offers pause/stop", async () => {
    const onSubmit = vi.fn();
    const editor = await renderEditor({ goal: ACTIVE_GOAL, onSubmit });

    // Objective + budget are seeded from the active goal.
    expect(container.querySelector<HTMLTextAreaElement>(".goal-dialog-objective")!.value).toBe(
      "Finish the migration",
    );
    container.querySelector<HTMLButtonElement>("[data-goal-editor-save]")!.click();
    expect(onSubmit).toHaveBeenCalledWith("/goal edit Finish the migration --budget 5000");

    onSubmit.mockClear();
    await renderEditor({ goal: ACTIVE_GOAL, onSubmit });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".goal-dialog-actions .btn")];
    buttons.find((b) => b.classList.contains("danger"))!.click();
    expect(onSubmit).toHaveBeenCalledWith("/goal stop");
    void editor;
  });

  it("disables save with an empty objective", async () => {
    await renderEditor({ goal: null });
    const save = container.querySelector<HTMLButtonElement>("[data-goal-editor-save]")!;
    expect(save.disabled).toBe(true);
  });
});
