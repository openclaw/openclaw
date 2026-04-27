import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { markdownTheme, theme } from "../theme/theme.js";
import { sanitizeRenderableText } from "../tui-formatters.js";
const PREVIEW_LINES = 12;
function formatArgs(toolName, args) {
    const display = resolveToolDisplay({ name: toolName, args });
    const detail = formatToolDetail(display);
    if (detail) {
        return sanitizeRenderableText(detail);
    }
    if (!args || typeof args !== "object") {
        return "";
    }
    try {
        return sanitizeRenderableText(JSON.stringify(args));
    }
    catch {
        return "";
    }
}
function extractText(result) {
    if (!result?.content) {
        return "";
    }
    const lines = [];
    for (const entry of result.content) {
        if (entry.type === "text" && entry.text) {
            lines.push(sanitizeRenderableText(entry.text));
        }
        else if (entry.type === "image") {
            const mime = entry.mimeType ?? "image";
            const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
            const omitted = entry.omitted ? " (omitted)" : "";
            lines.push(`[${mime}${size}${omitted}]`);
        }
    }
    return lines.join("\n").trim();
}
export class ToolExecutionComponent extends Container {
    box;
    header;
    argsLine;
    output;
    toolName;
    args;
    result;
    expanded = false;
    isError = false;
    isPartial = true;
    constructor(toolName, args) {
        super();
        this.toolName = toolName;
        this.args = args;
        this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
        this.header = new Text("", 0, 0);
        this.argsLine = new Text("", 0, 0);
        this.output = new Markdown("", 0, 0, markdownTheme, {
            color: (line) => theme.toolOutput(line),
        });
        this.addChild(new Spacer(1));
        this.addChild(this.box);
        this.box.addChild(this.header);
        this.box.addChild(this.argsLine);
        this.box.addChild(this.output);
        this.refresh();
    }
    setArgs(args) {
        this.args = args;
        this.refresh();
    }
    setExpanded(expanded) {
        this.expanded = expanded;
        this.refresh();
    }
    setResult(result, opts) {
        this.result = result;
        this.isPartial = false;
        this.isError = Boolean(opts?.isError);
        this.refresh();
    }
    setPartialResult(result) {
        this.result = result;
        this.isPartial = true;
        this.refresh();
    }
    refresh() {
        const bg = this.isPartial
            ? theme.toolPendingBg
            : this.isError
                ? theme.toolErrorBg
                : theme.toolSuccessBg;
        this.box.setBgFn((line) => bg(line));
        const display = resolveToolDisplay({
            name: this.toolName,
            args: this.args,
        });
        const title = `${display.emoji} ${display.label}${this.isPartial ? " (running)" : ""}`;
        this.header.setText(theme.toolTitle(theme.bold(title)));
        const argLine = formatArgs(this.toolName, this.args);
        this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));
        const raw = extractText(this.result);
        const text = raw || (this.isPartial ? "…" : "");
        if (!this.expanded && text) {
            const lines = text.split("\n");
            const preview = lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…` : text;
            this.output.setText(preview);
        }
        else {
            this.output.setText(text);
        }
    }
}
