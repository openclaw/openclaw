import type {
  ClawsDraftsCreateResult,
  ClawsDraftsPublishResult,
  ClawsDraftsReadResult,
  ClawsDraftsReviewResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { retainRejectedInitialTurn } from "../new-session/rejected-initial-turn.ts";
import { canCreateClawDraft, clawDraftUrl, type ClawDraftTarget } from "./draft-navigation.ts";

type DraftScope = ClawDraftTarget & { client: GatewayBrowserClient };

/** A page-local cache; the Gateway owns draft revisions and publication authority. */
export class ClawDraftPageState {
  private scope: DraftScope | null = null;
  private readonly listeners = new Set<() => void>();
  private created: ClawsDraftsCreateResult | null = null;
  content = "";
  saved: ClawsDraftsReadResult | null = null;
  review: ClawsDraftsReviewResult | null = null;
  publication: ClawsDraftsPublishResult | null = null;
  busy: "load" | "generate" | "save" | "review" | "publish" | null = null;
  error: string | null = null;

  constructor(private readonly context: ApplicationContext) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  sync(target: ClawDraftTarget) {
    const client = canCreateClawDraft(this.context) ? this.context.gateway.snapshot.client : null;
    if (
      this.scope?.client === client &&
      this.scope?.agentId === target.agentId &&
      this.scope?.draftId === target.draftId &&
      this.scope?.sourceSessionKey === target.sourceSessionKey
    ) {
      return;
    }
    this.scope = client ? { ...target, client } : null;
    this.created = null;
    this.content = "";
    this.saved = null;
    this.review = null;
    this.publication = null;
    this.busy = null;
    this.error = null;
    this.changed();
    if (this.scope?.draftId) {
      void this.load();
    }
  }

  dispose() {
    this.scope = null;
    this.listeners.clear();
  }

  get available() {
    return this.scope !== null;
  }

  get dirty() {
    return this.saved !== null && this.content !== this.saved.content;
  }

  get createdReviewUrl() {
    return this.scope && this.created
      ? clawDraftUrl(this.context.basePath, {
          agentId: this.scope.agentId,
          draftId: this.created.draftId,
        })
      : null;
  }

  edit(content: string) {
    this.content = content;
    this.review = null;
    this.changed();
  }

  private isCurrent(scope: DraftScope) {
    return this.scope === scope && this.context.gateway.snapshot.client === scope.client;
  }

  private async run(
    action: NonNullable<ClawDraftPageState["busy"]>,
    operation: (scope: DraftScope) => Promise<void>,
  ) {
    const scope = this.scope;
    if (!scope || this.busy) {
      return;
    }
    this.busy = action;
    this.error = null;
    this.changed();
    try {
      await operation(scope);
    } catch (error) {
      if (this.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(scope)) {
        this.busy = null;
        this.changed();
      }
    }
  }

  async load() {
    if (this.dirty && !window.confirm(t("clawsDraft.discardBeforeReload"))) {
      return;
    }
    await this.run("load", async (scope) => {
      if (!scope.draftId) {
        return;
      }
      const result = await scope.client.request<ClawsDraftsReadResult>("claws.drafts.read", {
        agentId: scope.agentId,
        draftId: scope.draftId,
      });
      if (this.isCurrent(scope)) {
        this.saved = result;
        this.content = result.content;
        this.review = null;
      }
    });
  }

  async save() {
    await this.run("save", async (scope) => {
      if (!scope.draftId || !this.saved) {
        return;
      }
      const result = await scope.client.request<ClawsDraftsReadResult>("claws.drafts.save", {
        agentId: scope.agentId,
        draftId: scope.draftId,
        content: this.content,
        expectedRevision: this.saved.revision,
      });
      if (this.isCurrent(scope)) {
        this.saved = result;
        this.content = result.content;
        this.review = null;
        this.publication = null;
      }
    });
  }

  async prepareReview() {
    if (this.dirty) {
      return;
    }
    await this.run("review", async (scope) => {
      if (!scope.draftId || !this.saved) {
        return;
      }
      this.review = null;
      const result = await scope.client.request<ClawsDraftsReviewResult>("claws.drafts.review", {
        agentId: scope.agentId,
        draftId: scope.draftId,
      });
      if (!this.isCurrent(scope)) {
        return;
      }
      if (result.revision !== this.saved.revision) {
        throw new Error(t("clawsDraft.changed"));
      }
      this.review = result;
    });
  }

  async publish() {
    const review = this.review;
    if (!review || this.dirty || this.publication) {
      return;
    }
    await this.run("publish", async (scope) => {
      if (!scope.draftId) {
        return;
      }
      // A failed response may follow an accepted upload; require another review before retrying.
      this.review = null;
      const result = await scope.client.request<ClawsDraftsPublishResult>("claws.drafts.publish", {
        agentId: scope.agentId,
        draftId: scope.draftId,
        reviewToken: review.reviewToken,
      });
      if (this.isCurrent(scope)) {
        this.publication = result;
      }
    });
  }

  async generate() {
    await this.run("generate", async (scope) => {
      const context = this.context;
      const sourceContext = scope.sourceSessionKey
        ? {
            parentSessionKey: scope.sourceSessionKey,
            fork: true,
            forkFrom: "last-completed" as const,
          }
        : {};
      const access = readSessionMethodAccess(context.gateway.snapshot, {
        method: "sessions.create",
        params: { agentId: scope.agentId, ...sourceContext },
      });
      if (!access.allowed) {
        throw new Error(access.reason);
      }
      const draft =
        this.created ??
        (await scope.client.request<ClawsDraftsCreateResult>("claws.drafts.create", {
          agentId: scope.agentId,
          ...(scope.sourceSessionKey ? { sourceSessionKey: scope.sourceSessionKey } : {}),
        }));
      if (!this.isCurrent(scope)) {
        return;
      }
      this.created = draft;
      this.changed();
      const reviewUrl = clawDraftUrl(context.basePath, {
        agentId: scope.agentId,
        draftId: draft.draftId,
      });
      const message = `${draft.prompt}\n\nWhen the private draft is ready, give me this link to inspect, edit, and explicitly publish it: [Review Claw draft](${reviewUrl}). Do not publish it yourself.`;
      const createdAt = Date.now();
      const result = await context.sessions.createResult(
        {
          agentId: scope.agentId,
          ...sourceContext,
          displayName: t("clawsDraft.title"),
          message,
          idempotencyKey: generateUUID(),
        },
        { reconciliation: "background" },
      );
      if (context.gateway.snapshot.client !== scope.client) {
        return;
      }
      if (!result) {
        throw new Error(context.sessions.state.error ?? t("clawsDraft.startFailed"));
      }
      // An accepted run belongs to the session even after the initiating page is replaced.
      if (result.initialRun.status === "started") {
        context.chatSubmissions.retain(
          buildInitialChatSubmission(
            result.key,
            { text: message, createdAt },
            scope.client,
            result.initialRun.runId,
          ),
        );
      } else if (result.initialRun.status === "rejected") {
        retainRejectedInitialTurn({
          context,
          agentId: scope.agentId,
          sessionKey: result.key,
          message,
          attachments: [],
          error: result.initialRun.error,
        });
      }
      if (this.isCurrent(scope)) {
        context.navigate(
          "chat",
          sessionNavigationTarget({
            context,
            face: "chat",
            sessionKey: result.key,
            agentId: scope.agentId,
            navigationKey: result.key,
          }).options,
        );
      }
    });
  }
}
