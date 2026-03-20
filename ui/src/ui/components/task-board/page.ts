import { html, nothing } from "lit";
import { splitTaskBoardCardsByLane, type TaskBoardCardVM } from "../../task-board/types.ts";
import { renderTaskBoardLane } from "./lane.ts";
import { renderTaskBoardToolbar } from "./toolbar.ts";

export type TaskBoardPageProps = {
  loading: boolean;
  error: string | null;
  cards: TaskBoardCardVM[];
  lastLoadedAt: number | null;
  onRefresh: () => void;
};

function renderStateBanner(params: { title: string; body: string; tone?: "neutral" | "danger" }) {
  const tone = params.tone ?? "neutral";
  const border =
    tone === "danger"
      ? "var(--color-danger, #dc2626)"
      : "var(--border-color, rgba(255,255,255,0.12))";
  const bg = tone === "danger" ? "rgba(220,38,38,0.08)" : "var(--panel-2, rgba(255,255,255,0.03))";
  return html`
    <section
      class="card"
      style="margin-bottom: 16px; border-left: 4px solid ${border}; background: ${bg};"
    >
      <div class="card-title">${params.title}</div>
      <div class="card-sub" style="margin-top: 6px; line-height: 1.6;">${params.body}</div>
    </section>
  `;
}

export function renderTaskBoardPage(props: TaskBoardPageProps) {
  const lanes = splitTaskBoardCardsByLane(props.cards);
  const noData = props.cards.length === 0;

  return html`
    ${renderTaskBoardToolbar({
      loading: props.loading,
      lastLoadedAt: props.lastLoadedAt,
      onRefresh: props.onRefresh,
    })}

    ${
      props.error
        ? renderStateBanner({
            title: "读取失败",
            body: `Task Board 这轮没有拿到完整数据。可先点刷新重试；若持续失败，再回看 sessions.list / cron.list / cron.runs 的响应。错误：${props.error}`,
            tone: "danger",
          })
        : nothing
    }

    ${
      !props.error && props.loading && noData
        ? renderStateBanner({
            title: "正在加载",
            body: "Task Board 正在拉取 sessions 与 cron 数据。首次加载可能需要几秒。",
          })
        : nothing
    }

    ${
      !props.error && !props.loading && noData
        ? renderStateBanner({
            title: "当前没有可展示的数据",
            body: "这不是页面崩溃；只是这轮没有拿到 active session 或 scheduled job。可先点刷新，再判断是否真为空。",
          })
        : nothing
    }

    <section class="grid grid--2" style="align-items: start;">
      ${renderTaskBoardLane({
        title: "当前主动任务",
        subtitle: "只看仍在推进的 active sessions。",
        cards: lanes.active,
        emptyText: props.loading ? "主动任务加载中…" : "当前没有可显示的主动任务。",
      })}
      ${renderTaskBoardLane({
        title: "定时任务",
        subtitle: "只看 cron / scheduled jobs 的运行健康。",
        cards: lanes.scheduled,
        emptyText: props.loading ? "定时任务加载中…" : "当前没有可显示的定时任务。",
      })}
    </section>
  `;
}
