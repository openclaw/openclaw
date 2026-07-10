/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n/index.ts";
import type { InlinePlanApproval } from "./inline-plan-approval.ts";
import "./inline-plan-approval.ts";

let container: HTMLDivElement;

async function renderCard(handlers: {
  summary?: string | null;
  busy?: boolean;
  onApprove?: () => void;
  onRevise?: (feedback: string) => void;
}): Promise<InlinePlanApproval> {
  render(
    html`
      <openclaw-inline-plan-approval
        .props=${{
          summary: handlers.summary ?? null,
          busy: handlers.busy ?? false,
          onApprove: handlers.onApprove ?? (() => undefined),
          onRevise: handlers.onRevise ?? (() => undefined),
        }}
      ></openclaw-inline-plan-approval>
    `,
    container,
  );
  const card = container.querySelector("openclaw-inline-plan-approval") as InlinePlanApproval;
  await card.updateComplete;
  return card;
}

describe("openclaw-inline-plan-approval", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders the Codex prompt, summary, and approve/revise actions", async () => {
    await renderCard({ summary: "Ship the parity UI" });
    expect(container.querySelector(".inline-plan-approval__title")?.textContent).toBe(
      t("plan.approveTitle"),
    );
    expect(container.querySelector(".inline-plan-approval__summary")?.textContent).toContain(
      "Ship the parity UI",
    );
    expect(container.querySelector("[data-plan-approve]")).not.toBeNull();
    expect(container.querySelector("[data-plan-revise]")).not.toBeNull();
  });

  it("approves through the approve button", async () => {
    const onApprove = vi.fn();
    await renderCard({ onApprove });
    container.querySelector<HTMLButtonElement>("[data-plan-approve]")!.click();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("reveals a feedback field and sends the revision text", async () => {
    const onRevise = vi.fn();
    const card = await renderCard({ onRevise });

    container.querySelector<HTMLButtonElement>("[data-plan-revise]")!.click();
    await card.updateComplete;
    const feedback = container.querySelector<HTMLTextAreaElement>(
      ".inline-plan-approval__feedback",
    );
    expect(feedback).not.toBeNull();
    feedback!.value = "  tighten the gate  ";
    feedback!.dispatchEvent(new Event("input"));
    await card.updateComplete;

    container.querySelector<HTMLButtonElement>("[data-plan-revise-submit]")!.click();
    expect(onRevise).toHaveBeenCalledWith("tighten the gate");
  });

  it("sends an empty revision when no feedback is typed", async () => {
    const onRevise = vi.fn();
    const card = await renderCard({ onRevise });
    container.querySelector<HTMLButtonElement>("[data-plan-revise]")!.click();
    await card.updateComplete;
    container.querySelector<HTMLButtonElement>("[data-plan-revise-submit]")!.click();
    expect(onRevise).toHaveBeenCalledWith("");
  });
});
