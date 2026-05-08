import {
  type Component,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExecApprovalActionDescriptor } from "../../infra/exec-approval-reply.js";
import { theme, selectListTheme } from "../theme/theme.js";

type PluginApprovalCardParams = {
  approvalId: string;
  title: string;
  description?: string;
  severity?: "info" | "warning" | "critical";
  pluginId?: string;
  toolName?: string;
  actions: readonly ExecApprovalActionDescriptor[];
  onAction?: (action: ExecApprovalActionDescriptor) => void;
  onCancel?: () => void;
};

function padRight(text: string, width: number): string {
  const used = visibleWidth(text);
  if (used >= width) {
    return text;
  }
  return `${text}${" ".repeat(width - used)}`;
}

function wrapCardText(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width)).flatMap((line) =>
    line.length > 0 ? [line] : [""],
  );
}

export class PluginApprovalCard implements Component {
  private readonly selectList: SelectList;
  private readonly actionByValue = new Map<string, ExecApprovalActionDescriptor>();
  private readonly params: PluginApprovalCardParams;

  constructor(params: PluginApprovalCardParams) {
    this.params = params;
    const items: SelectItem[] = params.actions.map((action) => {
      this.actionByValue.set(action.command, action);
      return {
        value: action.command,
        label: action.label,
        description:
          action.kind === "decision"
            ? `Decision: ${action.decision ?? "custom"}`
            : "Command action",
      };
    });
    this.selectList = new SelectList(
      items,
      Math.max(3, Math.min(items.length, 4)),
      selectListTheme,
    );
    this.selectList.onSelect = (item) => {
      const action = this.actionByValue.get(item.value);
      if (action) {
        this.params.onAction?.(action);
      }
    };
    this.selectList.onCancel = () => {
      this.params.onCancel?.();
    };
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.params.onCancel?.();
      return;
    }
    this.selectList.handleInput(data);
  }

  render(width: number): string[] {
    const contentWidth = Math.max(20, width - 4);
    const frameLine = (line = "") =>
      `${theme.border("| ")}${padRight(line, contentWidth)}${theme.border(" |")}`;
    const lines: string[] = [];
    lines.push(theme.border(`+${"-".repeat(contentWidth + 2)}+`));

    const banner =
      this.params.severity === "critical"
        ? theme.error("Verification required")
        : this.params.severity === "info"
          ? theme.accentSoft("Verification required")
          : theme.header("Verification required");
    lines.push(frameLine(banner));
    lines.push(frameLine());

    for (const line of wrapCardText(theme.bold(this.params.title), contentWidth)) {
      lines.push(frameLine(line));
    }

    if (this.params.description) {
      lines.push(frameLine());
      for (const line of wrapCardText(theme.dim(this.params.description), contentWidth)) {
        lines.push(frameLine(line));
      }
    }

    const metadata = [
      this.params.pluginId ? `Plugin: ${this.params.pluginId}` : null,
      this.params.toolName ? `Tool: ${this.params.toolName}` : null,
      `Approval ID: ${this.params.approvalId}`,
    ].filter((entry): entry is string => Boolean(entry));
    if (metadata.length > 0) {
      lines.push(frameLine());
      for (const entry of metadata) {
        lines.push(frameLine(theme.dim(entry)));
      }
    }

    lines.push(frameLine());
    lines.push(frameLine(theme.accentSoft("Choose an action:")));
    for (const line of this.selectList.render(contentWidth)) {
      lines.push(frameLine(line));
    }

    lines.push(frameLine());
    for (const line of wrapCardText(
      theme.dim(
        "Enter = continue, Esc = dismiss. The original action resumes automatically after verification succeeds.",
      ),
      contentWidth,
    )) {
      lines.push(frameLine(line));
    }
    lines.push(theme.border(`+${"-".repeat(contentWidth + 2)}+`));
    return lines;
  }
}
