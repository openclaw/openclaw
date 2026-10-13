import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { compactApprovalCommand } from "../app/approval-presentation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { canUseQuestionPrompts } from "../app/question-prompt-client.ts";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
} from "../app/question-prompt.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { activeSessionAgentStatus, sessionRowAttention } from "../lib/session-attention.ts";
import { uiConversationMatches } from "../lib/sessions/session-key.ts";
import { nextSessionSnoozeWakeAt } from "../lib/sessions/session-snooze.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  summarizeSidebarSessionAttention,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";

interface SessionAttentionControllerHost extends ReactiveControllerHost {
  readonly isConnected: boolean;
  readonly sessionAttentionContext: ApplicationContext | undefined;
}

type SessionAttentionResolver = (
  row: Partial<GatewaySessionRow> & { key: string },
) => SidebarSessionAttention;

/** Session-scoped question, approval, and failed-run attention ownership. */
export class SessionAttentionController implements ReactiveController {
  revision = 0;
  private resolverInputs: readonly unknown[] = [];
  private resolver: SessionAttentionResolver | undefined;
  private readonly attentionSubscriptions: SubscriptionsController;
  private readonly questionPromptState: ReturnType<typeof createQuestionPromptState>;
  private attentionGateway: ApplicationContext["gateway"] | null = null;
  private attentionGatewayClient: GatewayBrowserClient | null = null;
  private attentionGatewayConnected = false;
  private agentStatusExpiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private agentStatusExpiryAt: number | null = null;
  private snoozeWakeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(private readonly host: SessionAttentionControllerHost) {
    host.addController(this);
    this.attentionSubscriptions = new SubscriptionsController(host);
    this.questionPromptState = createQuestionPromptState(this.invalidate);
    this.attentionSubscriptions
      .watchStore(
        () => host.sessionAttentionContext?.gateway,
        (gateway) => this.synchronizeAttentionGateway(gateway),
      )
      .effect(
        () => host.sessionAttentionContext?.gateway,
        (gateway) =>
          gateway.subscribeEvents((event) => {
            handleQuestionPromptEvent(this.questionPromptState, event);
          }),
      )
      .watchStore(() => host.sessionAttentionContext?.overlays, this.invalidate);
  }

  private readonly invalidate = () => {
    this.revision += 1;
    this.host.requestUpdate();
  };

  hostDisconnected(): void {
    this.revision += 1;
    this.attentionGateway = null;
    this.attentionGatewayClient = null;
    this.attentionGatewayConnected = false;
    if (this.agentStatusExpiryTimer) {
      globalThis.clearTimeout(this.agentStatusExpiryTimer);
      this.agentStatusExpiryTimer = null;
      this.agentStatusExpiryAt = null;
    }
    if (this.snoozeWakeTimer !== null) {
      globalThis.clearTimeout(this.snoozeWakeTimer);
      this.snoozeWakeTimer = null;
    }
    disposeQuestionPromptState(this.questionPromptState);
  }

  private synchronizeAttentionGateway(gateway: ApplicationContext["gateway"]) {
    const connected = gateway.snapshot.phase === "connected";
    const client =
      connected &&
      canUseQuestionPrompts(gateway.snapshot) &&
      isGatewayMethodAdvertised({ hello: gateway.snapshot.hello }, "question.list") === true
        ? gateway.snapshot.client
        : null;
    if (
      gateway === this.attentionGateway &&
      client === this.attentionGatewayClient &&
      connected === this.attentionGatewayConnected
    ) {
      return;
    }
    this.attentionGateway = gateway;
    this.attentionGatewayClient = client;
    this.attentionGatewayConnected = connected;
    this.invalidate();
    setQuestionPromptClient(this.questionPromptState, client);
    if (client) {
      refreshPendingQuestionsWithRetry(
        this.questionPromptState,
        client,
        () =>
          this.host.isConnected &&
          this.host.sessionAttentionContext?.gateway === gateway &&
          gateway.snapshot.phase === "connected" &&
          gateway.snapshot.client === client,
      );
    }
  }

  resolveSessionAgentStatus(
    row: Pick<GatewaySessionRow, "agentStatus">,
  ): SessionAgentStatus | undefined {
    const status = activeSessionAgentStatus(row);
    if (!status) {
      return undefined;
    }
    this.scheduleAgentStatusExpiry(status.expiresAt);
    return status;
  }

  private scheduleAgentStatusExpiry(expiresAt: number): void {
    // Lit can finish a queued render after disconnect has retired this timer.
    if (!this.host.isConnected) {
      return;
    }
    // The gateway owns expiry; this timer only invalidates an otherwise-idle
    // sidebar so it stops rendering the declaration at the server timestamp.
    if (this.agentStatusExpiryAt !== null && this.agentStatusExpiryAt <= expiresAt) {
      return;
    }
    if (this.agentStatusExpiryTimer) {
      globalThis.clearTimeout(this.agentStatusExpiryTimer);
    }
    this.agentStatusExpiryAt = expiresAt;
    this.agentStatusExpiryTimer = globalThis.setTimeout(
      () => {
        this.agentStatusExpiryTimer = null;
        this.agentStatusExpiryAt = null;
        this.invalidate();
      },
      Math.max(0, expiresAt - Date.now() + 1),
    );
  }

  scheduleSessionSnoozeWake(rows: Iterable<Pick<GatewaySessionRow, "snoozedUntil">>): void {
    if (this.snoozeWakeTimer !== null) {
      globalThis.clearTimeout(this.snoozeWakeTimer);
      this.snoozeWakeTimer = null;
    }
    const wakeAt = nextSessionSnoozeWakeAt(rows, Date.now());
    if (!this.host.isConnected || wakeAt === null) {
      return;
    }
    this.snoozeWakeTimer = globalThis.setTimeout(
      () => {
        this.snoozeWakeTimer = null;
        this.invalidate();
      },
      Math.min(2_147_483_647, Math.max(0, wakeAt - Date.now() + 1)),
    );
  }

  createResolver(): SessionAttentionResolver {
    const context = this.host.sessionAttentionContext;
    const identity = {
      hello: context?.gateway.snapshot.hello,
      agentsList: context?.agents.state.agentsList,
    };
    const inputs = [this.revision, identity.hello, identity.agentsList, context?.overlays];
    if (
      this.resolver &&
      inputs.every((value, index) => Object.is(value, this.resolverInputs[index]))
    ) {
      return this.resolver;
    }
    this.resolverInputs = inputs;
    const requests = [
      ...listQuestionPrompts(this.questionPromptState)
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
      ...(context?.overlays?.snapshot.approvalQueue ?? []).map((approval) => ({
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
    return (this.resolver = (row) => {
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
      this.resolveSessionAgentStatus(row);
      return sessionRowAttention(row);
    });
  }
}

function attentionPreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 240 ? `${truncateUtf16Safe(line, 239)}…` : line;
}
