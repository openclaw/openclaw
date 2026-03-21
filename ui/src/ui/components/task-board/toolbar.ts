import { html } from "lit";

export type TaskBoardToolbarProps = {
  loading: boolean;
  lastLoadedAt: number | null;
  onRefresh: () => void;
};

export function renderTaskBoardToolbar(props: TaskBoardToolbarProps) {
  return html`
    <section class="card" style="margin-bottom: 16px;">
      <div class="row" style="justify-content: space-between; align-items: center; gap: 12px;">
        <div>
          <div class="card-title">Phase 1 · Task Board</div>
          <div class="card-sub">
            只读切片：先看 active / scheduled 两栏，不读 transcript。
          </div>
        </div>
        <div class="row" style="gap: 10px; align-items: center;">
          <span class="muted" style="font-size: 12px;">
            ${props.lastLoadedAt ? `上次刷新：${new Date(props.lastLoadedAt).toLocaleTimeString()}` : "尚未加载"}
          </span>
          <button class="btn primary" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </div>
    </section>
  `;
}
