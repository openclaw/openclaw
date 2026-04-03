import type { Component } from "@mariozechner/pi-tui";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export class ChatLog extends Container {
  private readonly maxComponents: number;
  private viewportHeight: number | null = null;
  private scrollOffset = 0;
  private lastRenderWidth = 120;
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private btwMessage: BtwInlineMessage | null = null;
  private toolsExpanded = false;

  constructor(maxComponents = 180) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  private dropComponentReferences(component: Component) {
    for (const [toolId, tool] of this.toolById.entries()) {
      if (tool === component) {
        this.toolById.delete(toolId);
      }
    }
    for (const [runId, message] of this.streamingRuns.entries()) {
      if (message === component) {
        this.streamingRuns.delete(runId);
      }
    }
    if (this.btwMessage === component) {
      this.btwMessage = null;
    }
  }

  private pruneOverflow() {
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) {
        return;
      }
      this.removeChild(oldest);
      this.dropComponentReferences(oldest);
    }
  }

  private append(component: Component) {
    const wasAtLatest = this.scrollOffset === 0;
    const previousLineCount = wasAtLatest ? 0 : this.getRenderedLineCount(this.lastRenderWidth);
    this.addChild(component);
    this.pruneOverflow();
    if (wasAtLatest) {
      this.scrollToLatest();
      return;
    }
    const nextLineCount = this.getRenderedLineCount(this.lastRenderWidth);
    this.scrollOffset += Math.max(0, nextLineCount - previousLineCount);
    this.clampScrollOffset();
  }

  setViewportHeight(height: number | null) {
    if (height === null || Number.isNaN(height)) {
      this.viewportHeight = null;
      this.clampScrollOffset();
      return;
    }
    this.viewportHeight = Math.max(1, Math.floor(height));
    this.clampScrollOffset();
  }

  scrollPageUp() {
    const page = this.viewportHeight ?? 10;
    this.scrollLines(page);
  }

  scrollPageDown() {
    const page = this.viewportHeight ?? 10;
    this.scrollLines(-page);
  }

  scrollLines(delta: number) {
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    this.scrollOffset += Math.trunc(delta);
    this.clampScrollOffset();
  }

  scrollToLatest() {
    this.scrollOffset = 0;
  }

  private getRenderedLineCount(width: number) {
    return super.render(width).length;
  }

  private getMaxScrollOffset(width: number) {
    if (!this.viewportHeight) {
      return 0;
    }
    return Math.max(0, this.getRenderedLineCount(width) - this.viewportHeight);
  }

  private clampScrollOffset(width = this.lastRenderWidth) {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.getMaxScrollOffset(width)));
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.btwMessage = null;
    this.scrollToLatest();
  }

  private createSystemMessage(text: string): Container {
    const entry = new Container();
    entry.addChild(new Spacer(1));
    entry.addChild(new Text(theme.system(text), 1, 0));
    return entry;
  }

  addSystem(text: string) {
    this.append(this.createSystemMessage(text));
  }

  addUser(text: string) {
    this.append(new UserMessageComponent(text));
  }

  private resolveRunId(runId?: string) {
    return runId ?? "default";
  }

  startAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(text);
      return existing;
    }
    const component = new AssistantMessageComponent(text);
    this.streamingRuns.set(effectiveRunId, component);
    this.append(component);
    return component;
  }

  updateAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(text);
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(text);
      this.streamingRuns.delete(effectiveRunId);
      return;
    }
    this.append(new AssistantMessageComponent(text));
  }

  dropAssistant(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      return;
    }
    this.removeChild(existing);
    this.streamingRuns.delete(effectiveRunId);
  }

  showBtw(params: { question: string; text: string; isError?: boolean }) {
    if (this.btwMessage) {
      this.btwMessage.setResult(params);
      if (this.children[this.children.length - 1] !== this.btwMessage) {
        this.removeChild(this.btwMessage);
        this.append(this.btwMessage);
      }
      return this.btwMessage;
    }
    const component = new BtwInlineMessage(params);
    this.btwMessage = component;
    this.append(component);
    return component;
  }

  dismissBtw() {
    if (!this.btwMessage) {
      return;
    }
    this.removeChild(this.btwMessage);
    this.btwMessage = null;
  }

  hasVisibleBtw() {
    return this.btwMessage !== null;
  }

  startTool(toolCallId: string, toolName: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.append(component);
    return component;
  }

  updateToolArgs(toolCallId: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setArgs(args);
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    if (opts?.partial) {
      existing.setPartialResult(result as Record<string, unknown>);
      return;
    }
    existing.setResult(result as Record<string, unknown>, {
      isError: opts?.isError,
    });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
  }

  override render(width: number) {
    this.lastRenderWidth = width;
    const lines = super.render(width);
    if (!this.viewportHeight || lines.length <= this.viewportHeight) {
      this.scrollOffset = 0;
      return lines;
    }

    const maxOffset = Math.max(0, lines.length - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const start = Math.max(0, lines.length - this.viewportHeight - this.scrollOffset);
    const end = start + this.viewportHeight;
    return lines.slice(start, end);
  }
}
