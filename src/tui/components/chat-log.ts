import type { Component } from "@mariozechner/pi-tui";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

type ChatLogOptions = {
  preserveIntermediate?: boolean;
};

export class ChatLog extends Container {
  private readonly maxComponents: number;
  private readonly preserveIntermediate: boolean;
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private btwMessage: BtwInlineMessage | null = null;
  private toolsExpanded = false;

  constructor(maxComponents = 180, opts: ChatLogOptions = {}) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
    this.preserveIntermediate = Boolean(opts.preserveIntermediate);
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
    this.addChild(component);
    this.pruneOverflow();
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.btwMessage = null;
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
    if (this.preserveIntermediate) {
      const component = new AssistantMessageComponent(text);
      this.streamingRuns.set(effectiveRunId, component);
      this.append(component);
      return component;
    }

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
    if (this.preserveIntermediate) {
      this.startAssistant(text, runId);
      return;
    }

    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(text);
  }

  finalizeAssistant(text: string, runId?: string) {
    if (this.preserveIntermediate) {
      this.startAssistant(text, runId);
      const effectiveRunId = this.resolveRunId(runId);
      this.streamingRuns.delete(effectiveRunId);
      return;
    }

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

    // For preserveIntermediate, keep earlier intermediate fragments in history.
    // dropAssistant only removes the latest in-progress component so that it
    // does not remain in the active streaming slot; we retain the preserved history.
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
}
