import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { isApprovalStaleError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createTuiRefreshCoalescer } from "./coalesced-refresh.js";
import {
  TuiChoicePrompt,
  createTuiChoiceSelector,
  type TuiChoiceSelector,
} from "./components/choice-prompt.js";
import { tuiTheme as theme } from "./theme/theme.js";
import type { TuiApprovalDecision, TuiBackend, TuiPluginApproval } from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";
import { matchesOwnedTuiSession } from "./tui-session-events.js";
import { TuiSnapshotJournal } from "./tui-snapshot-journal.js";

const APPROVAL_BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeApprovalText(text: string): string {
  const flattened = text.replace(APPROVAL_BIDI_CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return sanitizeRenderableText(flattened);
}

function createApprovalPrompt(
  surfaceLabel: string,
  approval: TuiPluginApproval,
  selector: TuiChoiceSelector,
) {
  const title = sanitizeApprovalText(approval.request.title);
  const description = sanitizeApprovalText(approval.request.description ?? "");
  const severity = approval.request.severity ?? "warning";
  const metadata = [
    `Severity: ${severity === "critical" ? "Critical" : severity === "info" ? "Info" : "Warning"}`,
    ...(approval.request.toolName
      ? [`Tool: ${sanitizeApprovalText(approval.request.toolName)}`]
      : []),
    ...(approval.request.pluginId
      ? [`Plugin: ${sanitizeApprovalText(approval.request.pluginId)}`]
      : []),
  ];
  return new TuiChoicePrompt(
    theme.header(`${surfaceLabel}: ${title}`),
    [
      theme.dim(metadata.join("\n")),
      { text: theme.system(description ? `Request: ${description}` : ""), optional: true },
    ],
    selector,
  );
}

type ApprovalTimer = number | NodeJS.Timeout;

type TuiPluginApprovalControllerDeps = {
  client: Pick<TuiBackend, "listPluginApprovals" | "resolvePluginApproval">;
  chatLog: {
    addSystem: (line: string) => void;
  };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle: OverlayHandle) => void;
  requestRender: () => void;
  createSelector?: (items: SelectItem[]) => TuiChoiceSelector;
  nowMs?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ApprovalTimer;
  clearTimeoutFn?: (timer: ApprovalTimer) => void;
};

const DEFAULT_DECISIONS: readonly TuiApprovalDecision[] = ["allow-once", "allow-always", "deny"];

const DECISION_ITEMS: Record<TuiApprovalDecision, SelectItem> = {
  "allow-once": {
    value: "allow-once",
    label: "Allow once",
    description: "Approve this change",
  },
  "allow-always": {
    value: "allow-always",
    label: "Always allow",
    description: "Approve matching future changes",
  },
  deny: {
    value: "deny",
    label: "Deny",
    description: "Do not apply this change",
  },
};

function parseDecision(value: unknown): TuiApprovalDecision | null {
  return value === "allow-once" || value === "allow-always" || value === "deny" ? value : null;
}

function parseAllowedDecisions(value: unknown): TuiApprovalDecision[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const decisions: TuiApprovalDecision[] = [];
  for (const candidate of value) {
    const decision = parseDecision(candidate);
    if (decision && !decisions.includes(decision)) {
      decisions.push(decision);
    }
  }
  return decisions.length > 0 ? decisions : undefined;
}

function parseSeverity(value: unknown): TuiPluginApproval["request"]["severity"] {
  return value === "info" || value === "warning" || value === "critical" ? value : null;
}

function parseTuiPluginApproval(payload: unknown): TuiPluginApproval | null {
  const record = asOptionalObjectRecord(payload);
  const request = asOptionalObjectRecord(record?.request);
  if (!record || !request) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const title = typeof request.title === "string" ? request.title.trim() : "";
  const createdAtMs = typeof record.createdAtMs === "number" ? record.createdAtMs : 0;
  const expiresAtMs = typeof record.expiresAtMs === "number" ? record.expiresAtMs : 0;
  if (!id || !title || !createdAtMs || !expiresAtMs) {
    return null;
  }
  return {
    id,
    request: {
      title,
      description: typeof request.description === "string" ? request.description : null,
      pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
      severity: parseSeverity(request.severity),
      toolName: typeof request.toolName === "string" ? request.toolName : null,
      allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

function decisionLabel(decision: TuiApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "always allowed";
  }
  return "denied";
}

export function createTuiPluginApprovalController(deps: TuiPluginApprovalControllerDeps) {
  const createSelector = deps.createSelector ?? createTuiChoiceSelector;
  const nowMs = deps.nowMs ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let queue: TuiPluginApproval[] = [];
  type Presentation = { id: string; overlay?: OverlayHandle; timer?: ApprovalTimer };
  let active: Presentation | null = null;
  let disposed = false;
  const refreshRunner = createTuiRefreshCoalescer(refreshOnce);
  const mutations = new TuiSnapshotJournal<TuiPluginApproval>(refreshRunner.isRunning);
  const resolvingIds = new Set<string>();
  const dismissedIds = new Set<string>();

  const closeActiveOverlay = () => {
    const previous = active;
    if (previous?.timer !== undefined) {
      clearTimeoutFn(previous.timer);
    }
    active = null;
    if (previous?.overlay) {
      deps.closeOverlay(previous.overlay);
    }
  };

  const remove = (id: string) => {
    queue = queue.filter((approval) => approval.id !== id);
    dismissedIds.delete(id);
    mutations.record(id, null);
  };

  const add = (approval: TuiPluginApproval) => {
    queue = queue.filter((entry) => entry.id !== approval.id);
    queue.push(approval);
    queue.sort((left, right) => left.createdAtMs - right.createdAtMs);
    mutations.record(approval.id, approval);
  };

  const matchesActiveSession = (approval: TuiPluginApproval) =>
    matchesOwnedTuiSession(deps.getSessionKey(), deps.getAgentId(), approval.request);

  const prune = () => {
    const now = nowMs();
    for (const approval of queue.filter((entry) => entry.expiresAtMs <= now)) {
      remove(approval.id);
    }
  };

  const presentNext = () => {
    if (disposed || active) {
      return;
    }
    prune();
    const approval = queue.find(
      (candidate) =>
        !resolvingIds.has(candidate.id) &&
        !dismissedIds.has(candidate.id) &&
        matchesActiveSession(candidate),
    );
    if (!approval) {
      return;
    }
    const presentation: Presentation = { id: approval.id };
    active = presentation;
    const surfaceLabel = "plugin approval";

    const decisions = approval.request.allowedDecisions ?? DEFAULT_DECISIONS;
    const selector = createSelector(decisions.map((decision) => DECISION_ITEMS[decision]));
    let allowDecisionArmed = false;
    const prompt = createApprovalPrompt(surfaceLabel, approval, selector);
    const denyIndex = decisions.indexOf("deny");
    let selectedDecision = denyIndex >= 0 ? decisions[denyIndex] : decisions[0];
    if (denyIndex >= 0) {
      selector.setSelectedIndex?.(denyIndex);
    }
    selector.onSelectionChange = (item) => {
      const decision = parseDecision(item.value);
      if (!decision || decision === selectedDecision) {
        return;
      }
      selectedDecision = decision;
      allowDecisionArmed = decision !== "deny";
      prompt.setConfirmation("");
    };

    const resolve = async (decision: TuiApprovalDecision) => {
      if (active?.id !== approval.id) {
        return;
      }
      resolvingIds.add(approval.id);
      closeActiveOverlay();
      deps.requestRender();
      let stale = false;
      try {
        if (!deps.client.resolvePluginApproval) {
          throw new Error("plugin approval resolution is unavailable");
        }
        const result = await deps.client.resolvePluginApproval(approval.id, decision);
        if (disposed) {
          return;
        }
        if (result?.ok === false) {
          stale = true;
        } else {
          remove(approval.id);
          deps.chatLog.addSystem(`${surfaceLabel}: ${decisionLabel(decision)}`);
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        if (isApprovalStaleError(error)) {
          stale = true;
        } else {
          deps.chatLog.addSystem(`${surfaceLabel} failed: ${formatErrorMessage(error)}`);
        }
      }
      if (stale) {
        remove(approval.id);
        deps.chatLog.addSystem(`${surfaceLabel}: no longer pending`);
        try {
          await refreshApprovals();
        } catch (error) {
          if (!disposed) {
            deps.chatLog.addSystem(`${surfaceLabel} refresh failed: ${formatErrorMessage(error)}`);
          }
        }
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelect = (item) => {
      const decision = parseDecision(item.value);
      if (!decision) {
        return;
      }
      if (decision !== "deny" && !allowDecisionArmed) {
        allowDecisionArmed = true;
        prompt.setConfirmation(`Press Enter again to confirm ${item.label}.`);
        deps.requestRender();
        return;
      }
      void resolve(decision);
    };
    selector.onCancel = () => {
      const deny = decisions.includes("deny") ? "deny" : null;
      if (deny) {
        void resolve(deny);
        return;
      }
      dismissedIds.add(approval.id);
      closeActiveOverlay();
      deps.chatLog.addSystem(`${surfaceLabel}: dismissed; request remains pending`);
      presentNext();
      deps.requestRender();
    };
    const timer = setTimeoutFn(
      () => {
        if (active?.id !== approval.id) {
          return;
        }
        active.timer = undefined;
        remove(approval.id);
        closeActiveOverlay();
        deps.chatLog.addSystem(`${surfaceLabel}: expired`);
        presentNext();
        deps.requestRender();
      },
      Math.max(1, approval.expiresAtMs - nowMs()),
    );
    presentation.timer = timer;
    if (typeof timer !== "number") {
      timer.unref?.();
    }
    presentation.overlay = deps.openOverlay(prompt);
    deps.requestRender();
  };

  const applySnapshot = (approvals: TuiPluginApproval[], startedAtVersion: number) => {
    const next = mutations.replay(approvals, startedAtVersion, true);
    for (const id of dismissedIds) {
      if (!next.has(id)) {
        dismissedIds.delete(id);
      }
    }
    queue = [...next.values()].toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  };

  async function refreshOnce(): Promise<void> {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    const startedAtVersion = mutations.version;
    const payload = await deps.client.listPluginApprovals();
    if (disposed || !Array.isArray(payload)) {
      return;
    }
    const approvals: TuiPluginApproval[] = [];
    for (const entry of payload) {
      const approval = parseTuiPluginApproval(entry);
      if (approval) {
        approvals.push(approval);
      }
    }
    applySnapshot(approvals, startedAtVersion);
    if (active && !queue.some((approval) => approval.id === active?.id)) {
      closeActiveOverlay();
    }
    presentNext();
    deps.requestRender();
  }

  const refreshApprovals = async (): Promise<void> => {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    await refreshRunner.run();
  };

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed) {
        return;
      }
      if (event === "plugin.approval.requested") {
        const approval = parseTuiPluginApproval(payload);
        if (approval) {
          add(approval);
          presentNext();
        }
        return;
      }
      if (event !== "plugin.approval.resolved" && event !== "plugin.approval.removed") {
        return;
      }
      const value = asOptionalObjectRecord(payload)?.id;
      const id = typeof value === "string" ? value.trim() : "";
      if (!id) {
        return;
      }
      remove(id);
      resolvingIds.delete(id);
      if (active?.id === id) {
        closeActiveOverlay();
      }
      presentNext();
      deps.requestRender();
    },
    refresh: refreshApprovals,
    sessionChanged() {
      if (disposed) {
        return;
      }
      const activeApproval = active
        ? queue.find((approval) => approval.id === active?.id)
        : undefined;
      if (activeApproval && !matchesActiveSession(activeApproval)) {
        closeActiveOverlay();
        deps.requestRender();
      }
      presentNext();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      queue = [];
      dismissedIds.clear();
      mutations.clear();
      resolvingIds.clear();
      if (active) {
        closeActiveOverlay();
        deps.requestRender();
      }
    },
  };
}
