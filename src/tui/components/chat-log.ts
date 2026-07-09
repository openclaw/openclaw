// Chat log component lays out conversation messages for the TUI viewport.
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import {
  categorizeToolActivity,
  createEmptyToolActivityCounts,
  formatToolActivitySummary,
  type ToolActivityCounts,
} from "../tool-activity-summary.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

// Tolerates history timestamps slightly before locally pending messages.
const PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS = 60_000;

type RepeatableSystemMessage = {
  component: Container;
  textNode: Text;
  baseText: string;
  count: number;
};

/** Scrollback container that tracks pending users, streaming assistant runs, tools, and notices. */
export class ChatLog extends Container {
  private readonly maxComponents: number;
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private pendingUsers = new Map<
    string,
    {
      component: UserMessageComponent;
      text: string;
      createdAt: number;
    }
  >();
  private pendingSystemNotices = new Map<string, Container>();
  private btwMessage: BtwInlineMessage | null = null;
  private toolsExpanded = false;
  private repeatableSystemMessage: RepeatableSystemMessage | null = null;
  // Text already frozen into a completed segment component for a run, keyed by
  // runId. A run's assistant text streams cumulatively for its whole lifetime
  // (through tool calls) with no segment boundaries of its own, so once a tool
  // card lands mid-run we record how much text it already showed here and
  // strip that prefix from later updates — otherwise the next delta would
  // either duplicate that text in a new block or silently rewrite the old
  // component that is now stuck above the tool card.
  private committedTextByRun = new Map<string, string>();
  // Last full (unstripped) cumulative buffer seen per run. Freezing must
  // snapshot this, not the live component's already-stripped display text —
  // otherwise a second freeze in the same run loses the first freeze's
  // committed prefix and segmentTextFor's startsWith check falls through to
  // re-rendering the whole buffer (duplicating every earlier segment).
  private lastFullTextByRun = new Map<string, string>();
  // Per-run tool-call tally backing the one-line fuzzy summary shown when
  // verbose is off (startTool/updateToolResult are never called in that mode,
  // so this is the only tool feedback the user gets).
  private toolActivityCounts = new Map<string, ToolActivityCounts>();
  private toolActivitySeenCallIds = new Map<string, Set<string>>();
  private toolActivitySummaries = new Map<string, { component: Container; textNode: Text }>();

  constructor(maxComponents = 180) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  // Pruning must clear side maps so future stream/tool updates do not target detached components.
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
    for (const [runId, entry] of this.pendingUsers.entries()) {
      if (entry.component === component) {
        this.pendingUsers.delete(runId);
      }
    }
    for (const [runId, entry] of this.pendingSystemNotices.entries()) {
      if (entry === component) {
        this.pendingSystemNotices.delete(runId);
      }
    }
    for (const [runId, entry] of this.toolActivitySummaries.entries()) {
      if (entry.component === component) {
        this.toolActivitySummaries.delete(runId);
      }
    }
    if (this.btwMessage === component) {
      this.btwMessage = null;
    }
    if (this.repeatableSystemMessage?.component === component) {
      this.repeatableSystemMessage = null;
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

  private appendNonSystem(component: Component) {
    this.repeatableSystemMessage = null;
    this.append(component);
  }

  clearAll(opts?: { preservePendingUsers?: boolean }) {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.committedTextByRun.clear();
    this.lastFullTextByRun.clear();
    this.toolActivityCounts.clear();
    this.toolActivitySeenCallIds.clear();
    this.toolActivitySummaries.clear();
    this.pendingSystemNotices.clear();
    this.btwMessage = null;
    this.repeatableSystemMessage = null;
    if (!opts?.preservePendingUsers) {
      this.pendingUsers.clear();
    }
  }

  clearTools() {
    for (const tool of this.toolById.values()) {
      this.removeChild(tool);
    }
    this.toolById.clear();
  }

  restorePendingUsers() {
    for (const entry of this.pendingUsers.values()) {
      if (this.children.includes(entry.component)) {
        continue;
      }
      this.appendNonSystem(entry.component);
    }
  }

  clearPendingUsers() {
    for (const entry of this.pendingUsers.values()) {
      this.removeChild(entry.component);
    }
    this.pendingUsers.clear();
  }

  private formatRepeatedSystemText(text: string, count: number) {
    return count > 1 ? `${text} x${count}` : text;
  }

  private createSystemMessage(text: string): RepeatableSystemMessage {
    const entry = new Container();
    const textNode = new Text(theme.system(text), 1, 0);
    entry.addChild(new Spacer(1));
    entry.addChild(textNode);
    return {
      component: entry,
      textNode,
      baseText: text,
      count: 1,
    };
  }

  addSystem(text: string, opts?: { coalesceConsecutive?: boolean }) {
    if (
      opts?.coalesceConsecutive &&
      this.repeatableSystemMessage?.baseText === text &&
      this.children[this.children.length - 1] === this.repeatableSystemMessage.component
    ) {
      this.repeatableSystemMessage.count += 1;
      this.repeatableSystemMessage.textNode.setText(
        theme.system(this.formatRepeatedSystemText(text, this.repeatableSystemMessage.count)),
      );
      return;
    }
    const message = this.createSystemMessage(text);
    this.append(message.component);
    this.repeatableSystemMessage = opts?.coalesceConsecutive ? message : null;
  }

  addPendingSystem(runId: string, text: string) {
    const existing = this.pendingSystemNotices.get(runId);
    if (existing) {
      this.removeChild(existing);
    }
    const message = this.createSystemMessage(text);
    this.pendingSystemNotices.set(runId, message.component);
    this.append(message.component);
  }

  dismissPendingSystem(runId: string) {
    const existing = this.pendingSystemNotices.get(runId);
    if (!existing) {
      return false;
    }
    this.removeChild(existing);
    this.pendingSystemNotices.delete(runId);
    return true;
  }

  addUser(text: string) {
    this.appendNonSystem(new UserMessageComponent(text));
  }

  addPendingUser(runId: string, text: string, createdAt = Date.now()) {
    const existing = this.pendingUsers.get(runId);
    if (existing) {
      existing.text = text;
      existing.createdAt = createdAt;
      existing.component.setText(text);
      return existing.component;
    }
    const component = new UserMessageComponent(text);
    this.pendingUsers.set(runId, { component, text, createdAt });
    this.appendNonSystem(component);
    return component;
  }

  dropPendingUser(runId: string) {
    const existing = this.pendingUsers.get(runId);
    if (!existing) {
      return false;
    }
    this.removeChild(existing.component);
    this.pendingUsers.delete(runId);
    return true;
  }

  // Re-key in place: the gateway can assign its own runId after the optimistic
  // row is rendered. Swap the map key without re-mounting the component so the
  // row keeps its transcript position even if a reply already rendered below it.
  rekeyPendingUser(fromRunId: string, toRunId: string) {
    if (fromRunId === toRunId) {
      return false;
    }
    const existing = this.pendingUsers.get(fromRunId);
    if (!existing) {
      return false;
    }
    this.pendingUsers.delete(fromRunId);
    this.pendingUsers.set(toRunId, existing);
    return true;
  }

  reconcilePendingUsers(
    historyUsers: Array<{
      text: string;
      timestamp?: number | null;
    }>,
  ) {
    // Gateway history may echo a just-submitted local message; remove pending rows when it does.
    const normalizedHistory = historyUsers
      .map((entry) => ({
        text: entry.text.trim(),
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : null,
      }))
      .filter((entry) => entry.text.length > 0 && entry.timestamp !== null);
    const clearedRunIds: string[] = [];
    for (const [runId, entry] of this.pendingUsers.entries()) {
      const pendingText = entry.text.trim();
      if (!pendingText) {
        continue;
      }
      const matchIndex = normalizedHistory.findIndex(
        (historyEntry) =>
          historyEntry.text === pendingText &&
          (historyEntry.timestamp ?? 0) >=
            entry.createdAt - PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS,
      );
      if (matchIndex === -1) {
        continue;
      }
      if (this.children.includes(entry.component)) {
        this.removeChild(entry.component);
      }
      this.pendingUsers.delete(runId);
      clearedRunIds.push(runId);
      normalizedHistory.splice(matchIndex, 1);
    }
    return clearedRunIds;
  }

  countPendingUsers() {
    return this.pendingUsers.size;
  }

  // History replay (tui-session-actions.ts) feeds discrete, already-final
  // historical turns through updateAssistant()/startTool() so any tool call in
  // the replayed history freezes and segments text the same way a live run
  // does. Those turns are not a live cumulative run, so once replay finishes
  // the caller resets this bookkeeping — otherwise stale freeze state could
  // incorrectly strip a prefix from the next live run's first delta.
  resetStreamingAssistantState() {
    this.committedTextByRun.clear();
    this.lastFullTextByRun.clear();
    this.streamingRuns.clear();
  }

  private resolveRunId(runId?: string) {
    return runId ?? "default";
  }

  // Strips text already frozen into an earlier segment component for this run,
  // so a resumed run only renders the portion generated since that freeze.
  private segmentTextFor(runId: string, fullText: string) {
    const committed = this.committedTextByRun.get(runId);
    if (committed && fullText.startsWith(committed)) {
      return fullText.slice(committed.length).trimStart();
    }
    return fullText;
  }

  // Freezes any live streaming assistant components in place before a tool
  // card is appended. Without this, later deltas for the same run keep
  // rewriting the old component that now sits above the tool card instead of
  // starting a fresh one below it.
  private freezeStreamingRuns() {
    for (const runId of this.streamingRuns.keys()) {
      this.committedTextByRun.set(runId, this.lastFullTextByRun.get(runId) ?? "");
    }
    this.streamingRuns.clear();
  }

  startAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    this.lastFullTextByRun.set(effectiveRunId, text);
    const existing = this.streamingRuns.get(effectiveRunId);
    const segmentText = this.segmentTextFor(effectiveRunId, text);
    if (existing) {
      existing.setText(segmentText);
      return existing;
    }
    const component = new AssistantMessageComponent(segmentText);
    this.streamingRuns.set(effectiveRunId, component);
    this.appendNonSystem(component);
    return component;
  }

  reserveAssistantSlot(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      return existing;
    }
    return this.startAssistant("", runId);
  }

  updateAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    this.lastFullTextByRun.set(effectiveRunId, text);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(this.segmentTextFor(effectiveRunId, text));
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    const segmentText = this.segmentTextFor(effectiveRunId, text);
    this.committedTextByRun.delete(effectiveRunId);
    this.lastFullTextByRun.delete(effectiveRunId);
    if (existing) {
      existing.setText(segmentText);
      this.streamingRuns.delete(effectiveRunId);
      return;
    }
    this.appendNonSystem(new AssistantMessageComponent(segmentText));
  }

  dropAssistant(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    this.committedTextByRun.delete(effectiveRunId);
    this.lastFullTextByRun.delete(effectiveRunId);
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
        this.appendNonSystem(this.btwMessage);
      }
      return this.btwMessage;
    }
    const component = new BtwInlineMessage(params);
    this.btwMessage = component;
    this.appendNonSystem(component);
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
    this.freezeStreamingRuns();
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.appendNonSystem(component);
    return component;
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

  // One-line fuzzy activity summary for when verbose is off, e.g. "Read 2
  // files, ran 1 command and searched for 3 patterns" — updated in place as
  // more tools run in the same turn. Deduped by toolCallId so a duplicate
  // start event for the same call never double-counts.
  recordToolActivity(runId: string, toolName: string, toolCallId: string) {
    const seen = this.toolActivitySeenCallIds.get(runId) ?? new Set<string>();
    this.toolActivitySeenCallIds.set(runId, seen);
    if (seen.has(toolCallId)) {
      return;
    }
    seen.add(toolCallId);

    const counts = this.toolActivityCounts.get(runId) ?? createEmptyToolActivityCounts();
    counts[categorizeToolActivity(toolName)] += 1;
    this.toolActivityCounts.set(runId, counts);
    const text = theme.system(formatToolActivitySummary(counts));

    const existing = this.toolActivitySummaries.get(runId);
    if (existing) {
      existing.textNode.setText(text);
      return;
    }
    this.freezeStreamingRuns();
    const component = new Container();
    const textNode = new Text(text, 1, 0);
    component.addChild(new Spacer(1));
    component.addChild(textNode);
    this.toolActivitySummaries.set(runId, { component, textNode });
    this.appendNonSystem(component);
  }
}
