import { formatToolSummary, resolveToolDisplay } from "../agents/tool-display.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";

export type ToolSummaryLocale = "en" | "zh-CN" | "ko" | "ja";

type ToolAggregateOptions = {
  markdown?: boolean;
  locale?: ToolSummaryLocale;
};

export function shortenPath(p: string): string {
  return shortenHomePath(p);
}

export function shortenMeta(meta: string): string {
  if (!meta) {
    return meta;
  }
  return shortenHomeInString(meta);
}

export function formatToolAggregate(
  toolName?: string,
  metas?: string[],
  options?: ToolAggregateOptions,
): string {
  const filtered = (metas ?? []).filter(Boolean).map(shortenMeta);
  const display = resolveToolDisplay({ name: toolName });
  const locale = normalizeToolSummaryLocale(options?.locale);
  const prefix = `${display.emoji} ${resolveLocalizedToolLabel(toolName, locale) ?? display.label}`;
  if (!filtered.length) {
    return prefix;
  }

  const rawSegments: string[] = [];
  // Group by directory and brace-collapse filenames
  const grouped: Record<string, string[]> = {};
  for (const m of filtered) {
    if (!isPathLike(m)) {
      rawSegments.push(m);
      continue;
    }
    if (m.includes("→")) {
      rawSegments.push(m);
      continue;
    }
    const parts = m.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      const base = parts.at(-1) ?? m;
      if (!grouped[dir]) {
        grouped[dir] = [];
      }
      grouped[dir].push(base);
    } else {
      if (!grouped["."]) {
        grouped["."] = [];
      }
      grouped["."].push(m);
    }
  }

  const segments = Object.entries(grouped).map(([dir, files]) => {
    const brace = files.length > 1 ? `{${files.join(", ")}}` : files[0];
    if (dir === ".") {
      return brace;
    }
    return `${dir}/${brace}`;
  });

  const allSegments = [...rawSegments, ...segments];
  const meta = allSegments.join("; ");
  return `${prefix}: ${formatMetaForDisplay(toolName, meta, options?.markdown, locale)}`;
}

export function formatToolPrefix(toolName?: string, meta?: string) {
  const extra = meta?.trim() ? shortenMeta(meta) : undefined;
  const display = resolveToolDisplay({ name: toolName, meta: extra });
  return formatToolSummary(display);
}

function formatMetaForDisplay(
  toolName: string | undefined,
  meta: string,
  markdown?: boolean,
  locale?: ToolSummaryLocale,
): string {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  if (normalized === "exec" || normalized === "bash") {
    const { flags, body } = splitExecFlags(meta);
    const description = describeExecBody(body, locale ?? "en");
    if (flags.length > 0) {
      if (!body) {
        return flags.join(" · ");
      }
      if (description) {
        return `${flags.join(" · ")} · ${description} · ${maybeWrapMarkdown(body, markdown)}`;
      }
      return `${flags.join(" · ")} · ${maybeWrapMarkdown(body, markdown)}`;
    }
    if (description) {
      return `${description} · ${maybeWrapMarkdown(body, markdown)}`;
    }
  }
  return maybeWrapMarkdown(meta, markdown);
}

export function normalizeToolSummaryLocale(locale?: ToolSummaryLocale): ToolSummaryLocale {
  return locale === "zh-CN" || locale === "ko" || locale === "ja" ? locale : "en";
}

export function resolveLocalizedToolLabel(
  toolName: string | undefined,
  locale: ToolSummaryLocale,
): string | undefined {
  if (locale === "en") {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(toolName);
  if (!key) {
    return undefined;
  }
  switch (key) {
    case "read":
      return pickLocalizedLabel(locale, "读文件", "파일 읽기", "ファイル読み取り");
    case "write":
      return pickLocalizedLabel(locale, "写文件", "파일 쓰기", "ファイル書き込み");
    case "edit":
      return pickLocalizedLabel(locale, "编辑文件", "파일 수정", "ファイル編集");
    case "apply_patch":
    case "applypatch":
      return pickLocalizedLabel(locale, "打补丁", "패치 적용", "パッチ適用");
    case "attach":
      return pickLocalizedLabel(locale, "添加附件", "첨부", "添付");
    case "canvas":
      return pickLocalizedLabel(locale, "画布", "캔버스", "キャンバス");
    case "exec":
    case "bash":
      return pickLocalizedLabel(locale, "执行命令", "명령 실행", "コマンド実行");
    case "process":
      return pickLocalizedLabel(
        locale,
        "后台进程",
        "백그라운드 프로세스",
        "バックグラウンドプロセス",
      );
    case "browser":
      return pickLocalizedLabel(locale, "浏览器", "브라우저", "ブラウザ");
    case "web_search":
    case "websearch":
      return pickLocalizedLabel(locale, "网页搜索", "웹 검색", "Web検索");
    case "web_fetch":
    case "webfetch":
      return pickLocalizedLabel(locale, "抓取网页", "웹 가져오기", "Web取得");
    case "todo_write":
    case "todowrite":
      return pickLocalizedLabel(locale, "更新任务", "작업 업데이트", "タスク更新");
    case "tool_call":
    case "toolcall":
      return pickLocalizedLabel(locale, "工具调用", "도구 호출", "ツール呼び出し");
    default:
      return undefined;
  }
}

function pickLocalizedLabel(locale: ToolSummaryLocale, zhCn: string, ko: string, ja: string) {
  switch (locale) {
    case "zh-CN":
      return zhCn;
    case "ko":
      return ko;
    case "ja":
      return ja;
    default:
      return undefined;
  }
}

function describeExecBody(body: string, locale: ToolSummaryLocale): string | undefined {
  if (locale === "en") {
    return undefined;
  }
  const normalized = body.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("pnpm install")) {
    return pickLocalizedLabel(locale, "安装依赖", "의존성 설치", "依存関係をインストール");
  }
  if (normalized.startsWith("pnpm build")) {
    return pickLocalizedLabel(locale, "构建项目", "프로젝트 빌드", "プロジェクトをビルド");
  }
  if (normalized.startsWith("pnpm check")) {
    return pickLocalizedLabel(locale, "代码检查", "검사 실행", "チェック実行");
  }
  if (normalized.startsWith("pnpm test")) {
    return pickLocalizedLabel(locale, "运行测试", "테스트 실행", "テスト実行");
  }
  if (normalized.startsWith("npm install -g")) {
    return pickLocalizedLabel(locale, "全局安装", "전역 설치", "グローバルインストール");
  }
  if (normalized.startsWith("git status")) {
    return pickLocalizedLabel(locale, "查看 git 状态", "git 상태 확인", "git 状態確認");
  }
  if (normalized.startsWith("git diff")) {
    return pickLocalizedLabel(locale, "查看代码改动", "변경사항 확인", "差分確認");
  }
  if (normalized.startsWith("git log")) {
    return pickLocalizedLabel(locale, "查看提交历史", "히스토리 확인", "履歴確認");
  }
  if (normalized.startsWith("git pull")) {
    return pickLocalizedLabel(locale, "同步远端代码", "원격 변경사항 동기화", "リモート変更を同期");
  }
  if (normalized.startsWith("git push")) {
    return pickLocalizedLabel(locale, "推送到远端", "변경사항 푸시", "変更をプッシュ");
  }
  if (normalized.startsWith("openclaw gateway probe")) {
    return pickLocalizedLabel(locale, "探测网关状态", "게이트웨이 점검", "ゲートウェイ確認");
  }
  if (normalized.startsWith("openclaw message send")) {
    return pickLocalizedLabel(locale, "发送消息", "메시지 전송", "メッセージ送信");
  }
  if (normalized.startsWith("openclaw config set")) {
    return pickLocalizedLabel(locale, "更新配置", "설정 업데이트", "設定更新");
  }
  if (normalized.startsWith("openclaw config get")) {
    return pickLocalizedLabel(locale, "读取配置", "설정 확인", "設定確認");
  }
  if (normalized.startsWith("launchctl kickstart")) {
    return pickLocalizedLabel(locale, "重启常驻服务", "서비스 재시작", "サービス再起動");
  }
  if (
    normalized.startsWith("tail -f") ||
    normalized.startsWith("tail -n") ||
    normalized.includes(" tail -f ") ||
    normalized.includes(" tail -n ")
  ) {
    return pickLocalizedLabel(locale, "跟踪日志", "로그 추적", "ログ追跡");
  }
  if (normalized.startsWith("lsof ")) {
    return pickLocalizedLabel(locale, "查看端口占用", "포트 점검", "ポート確認");
  }
  if (normalized.startsWith("ps ")) {
    return pickLocalizedLabel(locale, "查看进程", "프로세스 확인", "プロセス確認");
  }
  if (normalized.startsWith("ls ")) {
    return pickLocalizedLabel(locale, "列出目录", "파일 목록 확인", "ファイル一覧");
  }
  if (normalized.startsWith("rg ") || normalized.startsWith("grep ")) {
    return pickLocalizedLabel(locale, "搜索文本", "텍스트 검색", "テキスト検索");
  }
  return undefined;
}

function splitExecFlags(meta: string): { flags: string[]; body: string } {
  const parts = meta
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { flags: [], body: "" };
  }
  const flags: string[] = [];
  const bodyParts: string[] = [];
  for (const part of parts) {
    if (part === "elevated" || part === "pty") {
      flags.push(part);
      continue;
    }
    bodyParts.push(part);
  }
  return { flags, body: bodyParts.join(" · ") };
}

function isPathLike(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes(" ")) {
    return false;
  }
  if (value.includes("://")) {
    return false;
  }
  if (value.includes("·")) {
    return false;
  }
  if (value.includes("&&") || value.includes("||")) {
    return false;
  }
  return /^~?(\/[^\s]+)+$/.test(value);
}

function maybeWrapMarkdown(value: string, markdown?: boolean): string {
  if (!markdown) {
    return value;
  }
  const delimiter = "`".repeat(longestBacktickRun(value) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") || value.includes("\n") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}
