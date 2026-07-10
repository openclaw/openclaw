/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalChipEntry } from "../app/goal-chip.ts";
import { installDialogPolyfill, nextFrame } from "../test-helpers/modal-dialog.ts";
import type { GoalChip, GoalChipAction, GoalChipActionPayload } from "./goal-chip.ts";
import "./goal-chip.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

const ACTIVE: GoalChipEntry = {
  sessionKey: "agent:main:web:main",
  status: "active",
  objective: "finish the migration",
  tokensUsed: 120,
  tokenBudget: 5000,
};

type Action = { action: GoalChipAction; payload?: GoalChipActionPayload };

async function renderChip(
  goal: GoalChipEntry | null,
  onAction: (action: GoalChipAction, payload?: GoalChipActionPayload) => void,
  opts?: { busy?: boolean; error?: string | null },
): Promise<GoalChip> {
  render(
    html`
      <openclaw-goal-chip
        .props=${{ goal, busy: opts?.busy ?? false, error: opts?.error ?? null, onAction }}
      ></openclaw-goal-chip>
    `,
    container,
  );
  const chip = container.querySelector("openclaw-goal-chip") as GoalChip;
  await chip.updateComplete;
  return chip;
}

describe("openclaw-goal-chip", () => {
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

  it("renders nothing when there is no goal", async () => {
    const chip = await renderChip(null, () => {});
    expect(chip.querySelector(".goal-chip")).toBeNull();
  });

  it("renders the Pursuing-goal chip with objective, status, and usage", async () => {
    const chip = await renderChip(ACTIVE, () => {});
    const button = chip.querySelector(".goal-chip");
    expect(button).not.toBeNull();
    expect(chip.querySelector(".goal-chip-label")?.textContent).toBe("Pursuing goal");
    expect(chip.querySelector(".goal-chip-objective")?.textContent).toBe("finish the migration");
    expect(chip.querySelector(".goal-chip-status")?.textContent).toBe("Active");
    expect(chip.querySelector(".goal-chip-usage")?.textContent).toContain("120 / 5000");
  });

  it("opens the edit dialog pre-filled from the current goal", async () => {
    const chip = await renderChip(ACTIVE, () => {});
    chip.querySelector<HTMLButtonElement>(".goal-chip")!.click();
    await chip.updateComplete;
    await nextFrame();
    const objective = chip.querySelector<HTMLTextAreaElement>(".goal-dialog-objective");
    const budget = chip.querySelector<HTMLInputElement>(".goal-dialog-budget");
    expect(objective?.value).toBe("finish the migration");
    expect(budget?.value).toBe("5000");
  });

  it("dispatches pause from the dialog", async () => {
    const actions: Action[] = [];
    const chip = await renderChip(ACTIVE, (action, payload) => actions.push({ action, payload }));
    chip.querySelector<HTMLButtonElement>(".goal-chip")!.click();
    await chip.updateComplete;
    await nextFrame();
    const pauseButton = Array.from(chip.querySelectorAll<HTMLButtonElement>(".btn")).find(
      (b) => b.textContent?.trim() === "Pause",
    );
    pauseButton!.click();
    expect(actions).toEqual([{ action: "pause", payload: undefined }]);
  });

  it("dispatches edit with the edited objective and budget", async () => {
    const actions: Action[] = [];
    const chip = await renderChip(ACTIVE, (action, payload) => actions.push({ action, payload }));
    chip.querySelector<HTMLButtonElement>(".goal-chip")!.click();
    await chip.updateComplete;
    await nextFrame();
    const objective = chip.querySelector<HTMLTextAreaElement>(".goal-dialog-objective")!;
    objective.value = "ship the release";
    objective.dispatchEvent(new Event("input"));
    const budget = chip.querySelector<HTMLInputElement>(".goal-dialog-budget")!;
    budget.value = "8000";
    budget.dispatchEvent(new Event("input"));
    await chip.updateComplete;
    const saveButton = Array.from(chip.querySelectorAll<HTMLButtonElement>(".btn")).find(
      (b) => b.textContent?.trim() === "Save",
    );
    saveButton!.click();
    expect(actions).toEqual([
      { action: "edit", payload: { objective: "ship the release", tokenBudget: 8000 } },
    ]);
  });

  it("offers Resume (not Pause) for a paused goal", async () => {
    const chip = await renderChip({ ...ACTIVE, status: "paused" }, () => {});
    chip.querySelector<HTMLButtonElement>(".goal-chip")!.click();
    await chip.updateComplete;
    await nextFrame();
    const labels = Array.from(chip.querySelectorAll<HTMLButtonElement>(".btn")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toContain("Resume");
    expect(labels).not.toContain("Pause");
  });
});
