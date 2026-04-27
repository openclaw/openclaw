import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
const PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS = 60_000;
export class ChatLog extends Container {
    maxComponents;
    toolById = new Map();
    streamingRuns = new Map();
    pendingUsers = new Map();
    btwMessage = null;
    toolsExpanded = false;
    constructor(maxComponents = 180) {
        super();
        this.maxComponents = Math.max(20, Math.floor(maxComponents));
    }
    dropComponentReferences(component) {
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
        if (this.btwMessage === component) {
            this.btwMessage = null;
        }
    }
    pruneOverflow() {
        while (this.children.length > this.maxComponents) {
            const oldest = this.children[0];
            if (!oldest) {
                return;
            }
            this.removeChild(oldest);
            this.dropComponentReferences(oldest);
        }
    }
    append(component) {
        this.addChild(component);
        this.pruneOverflow();
    }
    clearAll(opts) {
        this.clear();
        this.toolById.clear();
        this.streamingRuns.clear();
        this.btwMessage = null;
        if (!opts?.preservePendingUsers) {
            this.pendingUsers.clear();
        }
    }
    restorePendingUsers() {
        for (const entry of this.pendingUsers.values()) {
            if (this.children.includes(entry.component)) {
                continue;
            }
            this.append(entry.component);
        }
    }
    clearPendingUsers() {
        for (const entry of this.pendingUsers.values()) {
            this.removeChild(entry.component);
        }
        this.pendingUsers.clear();
    }
    createSystemMessage(text) {
        const entry = new Container();
        entry.addChild(new Spacer(1));
        entry.addChild(new Text(theme.system(text), 1, 0));
        return entry;
    }
    addSystem(text) {
        this.append(this.createSystemMessage(text));
    }
    addUser(text) {
        this.append(new UserMessageComponent(text));
    }
    addPendingUser(runId, text, createdAt = Date.now()) {
        const existing = this.pendingUsers.get(runId);
        if (existing) {
            existing.text = text;
            existing.createdAt = createdAt;
            existing.component.setText(text);
            return existing.component;
        }
        const component = new UserMessageComponent(text);
        this.pendingUsers.set(runId, { component, text, createdAt });
        this.append(component);
        return component;
    }
    commitPendingUser(runId) {
        return this.pendingUsers.delete(runId);
    }
    dropPendingUser(runId) {
        const existing = this.pendingUsers.get(runId);
        if (!existing) {
            return false;
        }
        this.removeChild(existing.component);
        this.pendingUsers.delete(runId);
        return true;
    }
    hasPendingUser(runId) {
        return this.pendingUsers.has(runId);
    }
    reconcilePendingUsers(historyUsers) {
        const normalizedHistory = historyUsers
            .map((entry) => ({
            text: entry.text.trim(),
            timestamp: typeof entry.timestamp === "number" ? entry.timestamp : null,
        }))
            .filter((entry) => entry.text.length > 0 && entry.timestamp !== null);
        const clearedRunIds = [];
        for (const [runId, entry] of this.pendingUsers.entries()) {
            const pendingText = entry.text.trim();
            if (!pendingText) {
                continue;
            }
            const matchIndex = normalizedHistory.findIndex((historyEntry) => historyEntry.text === pendingText &&
                (historyEntry.timestamp ?? 0) >=
                    entry.createdAt - PENDING_HISTORY_CLOCK_SKEW_TOLERANCE_MS);
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
    resolveRunId(runId) {
        return runId ?? "default";
    }
    startAssistant(text, runId) {
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
    updateAssistant(text, runId) {
        const effectiveRunId = this.resolveRunId(runId);
        const existing = this.streamingRuns.get(effectiveRunId);
        if (!existing) {
            this.startAssistant(text, runId);
            return;
        }
        existing.setText(text);
    }
    finalizeAssistant(text, runId) {
        const effectiveRunId = this.resolveRunId(runId);
        const existing = this.streamingRuns.get(effectiveRunId);
        if (existing) {
            existing.setText(text);
            this.streamingRuns.delete(effectiveRunId);
            return;
        }
        this.append(new AssistantMessageComponent(text));
    }
    dropAssistant(runId) {
        const effectiveRunId = this.resolveRunId(runId);
        const existing = this.streamingRuns.get(effectiveRunId);
        if (!existing) {
            return;
        }
        this.removeChild(existing);
        this.streamingRuns.delete(effectiveRunId);
    }
    showBtw(params) {
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
    startTool(toolCallId, toolName, args) {
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
    updateToolArgs(toolCallId, args) {
        const existing = this.toolById.get(toolCallId);
        if (!existing) {
            return;
        }
        existing.setArgs(args);
    }
    updateToolResult(toolCallId, result, opts) {
        const existing = this.toolById.get(toolCallId);
        if (!existing) {
            return;
        }
        if (opts?.partial) {
            existing.setPartialResult(result);
            return;
        }
        existing.setResult(result, {
            isError: opts?.isError,
        });
    }
    setToolsExpanded(expanded) {
        this.toolsExpanded = expanded;
        for (const tool of this.toolById.values()) {
            tool.setExpanded(expanded);
        }
    }
}
