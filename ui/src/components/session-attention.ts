import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { compactApprovalCommand } from "../app/approval-presentation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { canUseQuestionPrompts } from "../app/question-prompt-client.ts";
import {
  type createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
} from "../app/question-prompt.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { projectGateway, projectOverlays } from "../lib/reactive/application.ts";
import { projectAgents } from "../lib/reactive/domain-capabilities.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { activeSessionAgentStatus, sessionRowAttention } from "../lib/session-attention.ts";
import { uiConversationMatches } from "../lib/sessions/session-key.ts";
import { nextSessionSnoozeWakeAt } from "../lib/sessions/session-snooze.ts";
import {
  summarizeSidebarSessionAttention,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";

type SessionAttentionResolver = (
  row: Partial<GatewaySessionRow> & { key: string },
) => SidebarSessionAttention;

export type SessionAttention = ReturnType<typeof createSessionAttention>;

/** Question records outlive a view root; subscriptions and display deadlines do not. */
export function createSessionAttention(
  context: ApplicationContext,
  questions: ReturnType<typeof createQuestionPromptState>,
  host: HTMLElement,
  presented: () => boolean,
) {
  const gateway = projectGateway(context.gateway);
  const overlays = projectOverlays(context.overlays);
  const agents = projectAgents(context.agents);
  const hello = createMemo(() => gateway.read().snapshot.hello);
  const agentsList = createMemo(() => agents.read().agentsList);
  const prompts = projectSource(questions, {
    read: (state) => listQuestionPrompts(state),
    subscribe: (state, notify) => {
      state.onChange = notify;
      return () => {
        state.onChange = () => {};
      };
    },
    equality: "revision",
  });
  const [ready, setReady] = createSignal(false);
  const [clock, setClock] = createSignal(0);
  const presentationClock = createParkedProjection(clock, presented);
  let agentStatusExpiryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let agentStatusExpiryAt = Infinity;
  let snoozeWakeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let snoozeWakeAt: number | null = null;
  const invalidateDeadline = () => {
    if (host.isConnected) {
      setClock((revision) => revision + 1);
    }
  };
  const client = createMemo(() => {
    const snapshot = gateway.read().snapshot;
    return ready() &&
      snapshot.phase === "connected" &&
      canUseQuestionPrompts(snapshot) &&
      isGatewayMethodAdvertised({ hello: snapshot.hello }, "question.list") === true
      ? snapshot.client
      : null;
  });
  createEffect(client, (current) => {
    setQuestionPromptClient(questions, current);
    if (current) {
      refreshPendingQuestionsWithRetry(
        questions,
        current,
        () =>
          host.isConnected &&
          context.gateway.snapshot.phase === "connected" &&
          context.gateway.snapshot.client === current,
      );
    }
    return () => disposeQuestionPromptState(questions);
  });
  onSettled(() => {
    setReady(true);
    return context.gateway.subscribeEvents((event) => {
      if (host.isConnected) {
        handleQuestionPromptEvent(questions, event);
      }
    });
  });
  onCleanup(() => {
    globalThis.clearTimeout(agentStatusExpiryTimer);
    globalThis.clearTimeout(snoozeWakeTimer);
  });

  function resolveSessionAgentStatus(
    row: Pick<GatewaySessionRow, "agentStatus">,
  ): SessionAgentStatus | undefined {
    presentationClock();
    const status = activeSessionAgentStatus(row);
    if (status && host.isConnected && status.expiresAt < agentStatusExpiryAt) {
      globalThis.clearTimeout(agentStatusExpiryTimer);
      agentStatusExpiryAt = status.expiresAt;
      // Gateway owns expiry; this timer retires an otherwise-idle display at its timestamp.
      agentStatusExpiryTimer = globalThis.setTimeout(
        () => {
          agentStatusExpiryAt = Infinity;
          invalidateDeadline();
        },
        Math.max(0, status.expiresAt - Date.now() + 1),
      );
    }
    return status;
  }

  function scheduleSessionSnoozeWake(
    rows: Iterable<Pick<GatewaySessionRow, "snoozedUntil">>,
  ): void {
    const wakeAt = host.isConnected ? nextSessionSnoozeWakeAt(rows, Date.now()) : null;
    if (wakeAt === snoozeWakeAt) {
      return;
    }
    globalThis.clearTimeout(snoozeWakeTimer);
    snoozeWakeAt = wakeAt;
    if (wakeAt !== null) {
      snoozeWakeTimer = globalThis.setTimeout(
        () => {
          snoozeWakeAt = null;
          invalidateDeadline();
        },
        Math.min(2_147_483_647, Math.max(0, wakeAt - Date.now() + 1)),
      );
    }
  }

  const resolve = createParkedProjection<SessionAttentionResolver>(() => {
    presentationClock();
    const identity = {
      hello: hello(),
      agentsList: agentsList(),
    };
    const requests = [
      ...prompts
        .read()
        .filter((prompt) => prompt.status === "pending")
        .map((prompt) => ({
          sessionKey: prompt.sessionKey,
          agentId: prompt.agentId,
          kind: "question" as const,
          id: prompt.id,
          preview: attentionPreview(prompt.questions[0]?.question ?? ""),
          count: prompt.questions.length,
          createdAtMs: prompt.createdAtMs,
        })),
      ...overlays.read().approvalQueue.map((approval) => ({
        sessionKey: approval.request.sessionKey,
        agentId: approval.request.agentId,
        kind: "approval" as const,
        id: approval.id,
        preview:
          approval.kind === "exec"
            ? compactApprovalCommand(approval.request.command)
            : attentionPreview(approval.pluginTitle ?? approval.request.command),
        count: 1,
        createdAtMs: approval.createdAtMs,
      })),
    ];
    return (row) => {
      const knownAttention = summarizeSidebarSessionAttention(
        requests
          .filter((request) =>
            uiConversationMatches(
              identity,
              row.key,
              request.sessionKey,
              request.agentId,
              row.agentId,
            ),
          )
          .map((request) => ({ kind: request.kind, requests: [request] })),
      );
      if (knownAttention.kind !== "none") {
        return knownAttention;
      }
      resolveSessionAgentStatus(row);
      return sessionRowAttention(row);
    };
  }, presented);

  return { resolve, resolveSessionAgentStatus, scheduleSessionSnoozeWake };
}

function attentionPreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 240 ? `${truncateUtf16Safe(line, 239)}…` : line;
}
