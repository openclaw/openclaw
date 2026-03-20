import { html } from "lit";
import type { TaskBoardCardVM } from "../../task-board/types.ts";
import { renderTaskCard } from "./card.ts";

export type TaskBoardLaneProps = {
  title: string;
  subtitle: string;
  cards: TaskBoardCardVM[];
  emptyText: string;
};

export function renderTaskBoardLane(props: TaskBoardLaneProps) {
  return html`
    <section class="card" style="display: flex; flex-direction: column; gap: 16px; min-height: 320px;">
      <div>
        <div class="card-title">${props.title}</div>
        <div class="card-sub">${props.subtitle}</div>
      </div>
      <div style="display: grid; gap: 12px;">
        ${
          props.cards.length > 0
            ? props.cards.map((card) => renderTaskCard(card))
            : html`<div class="muted">${props.emptyText}</div>`
        }
      </div>
    </section>
  `;
}
