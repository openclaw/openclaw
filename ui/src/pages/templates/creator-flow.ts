import type {
  TemplateDraftReviewItem,
  TemplateDraftReviewChoices,
  TemplatesDraftsCreateResult,
  TemplatesDraftsPublishResult,
  TemplatesDraftsReadResult,
  TemplatesDraftsReviewResult,
} from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { registerTemplateCreatorEnglish } from "../../i18n/locales/en-template-creator.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  templateCreatorOwner,
  type TemplateCreator,
  type TemplatePackagePreview,
  type TemplateReviewTarget,
} from "./creator-publication.ts";
import { canCreateTemplateDraft } from "./draft-navigation.ts";

registerEnglishCatalog(registerAgentsHomeEnglish);
registerEnglishCatalog(registerTemplateCreatorEnglish);

type Target = {
  agentId: string;
  draftId: string;
  sessionKey: string;
  client: GatewayBrowserClient;
};

function hasCompleteScope(content: string) {
  const document: unknown = JSON.parse(content);
  if (typeof document !== "object" || document === null || !("scope" in document)) {
    return false;
  }
  const scope = document.scope;
  return (
    typeof scope === "object" &&
    scope !== null &&
    ["input", "job", "output", "authority"].every((key) => {
      const value = Reflect.get(scope, key);
      return typeof value === "string" && value.trim().length > 0;
    })
  );
}

/** Connection-scoped presentation; the Gateway owns draft bytes and publication authority. */
export class TemplateCreatorFlow implements TemplateCreator {
  private readonly listeners = createChangeListeners();
  private target: Target | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reviewRequest = 0;
  private seenRevision: string | null = null;
  busy: "starting" | "reviewing" | "publishing" | null = null;
  review: TemplatesDraftsReviewResult | null = null;
  reviewCurrent = false;
  private choices: TemplateDraftReviewChoices | null = null;
  inlineReview = false;
  publication: TemplatesDraftsPublishResult | null = null;
  publicationIssue: "failed" | "unconfirmed" | null = null;
  private publicationAttemptId: string | undefined;
  private publicationReviewToken: string | undefined;
  error: string | null = null;

  get hasActiveDraft() {
    return this.target !== null;
  }

  constructor(private readonly context: ApplicationContext) {
    // Admission installs retirement before the cold presentation can mount.
    const router = context.router;
    let pathname = router.getState().location.pathname;
    router.subscribe(() => {
      const next = router.getState().location.pathname;
      if (next !== pathname) {
        pathname = next;
        this.retirePresentation();
      }
    });
    let client = context.gateway.snapshot.client;
    context.gateway.subscribe((snapshot) => {
      if (snapshot.client === client) {
        return;
      }
      client = snapshot.client;
      this.busy = null;
      this.reset(null);
    });
  }

  readonly subscribe = this.listeners.subscribe;

  private readonly changed = this.listeners.publish;

  retirePresentation() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
  }

  private mainSessionKey(agentId: string) {
    const mainKey = resolveUiConfiguredMainKey({
      agentsList: this.context.agents.state.agentsList,
      hello: this.context.gateway.snapshot.hello,
    });
    return buildAgentMainSessionKey({ agentId, mainKey });
  }

  private navigate(target: Target) {
    this.context.navigate(
      "chat",
      sessionNavigationTarget({
        context: this.context,
        face: "chat",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        navigationKey: target.sessionKey,
      }).options,
    );
  }

  private current(target: Target, generation: number) {
    return (
      this.target === target &&
      this.generation === generation &&
      this.context.gateway.snapshot.client === target.client
    );
  }

  private reset(target: Target | null) {
    this.retirePendingStart();
    this.retirePresentation();
    this.generation += 1;
    this.reviewRequest += 1;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.target = target;
    this.seenRevision = null;
    this.review = null;
    this.reviewCurrent = false;
    this.choices = null;
    this.publication = null;
    this.inlineReview = false;
    this.publicationIssue = null;
    this.publicationAttemptId = undefined;
    this.publicationReviewToken = undefined;
    this.error = null;
    this.changed();
    return this.generation;
  }

  async start(agentId: string) {
    const client = this.context.gateway.snapshot.client;
    if (!client || this.busy === "starting") {
      return;
    }
    this.retirePendingStart();
    let generation = this.generation;
    this.busy = "starting";
    this.error = null;
    this.changed();
    try {
      const created = await client.request<TemplatesDraftsCreateResult>("templates.drafts.create", {
        agentId,
      });
      if (this.context.gateway.snapshot.client !== client || this.generation !== generation) {
        return;
      }
      const target = {
        agentId,
        draftId: created.draftId,
        sessionKey: this.mainSessionKey(agentId),
        client,
      };
      generation = this.reset(target);
      const ack = await client.request<{ status?: string }>("chat.send", {
        sessionKey: target.sessionKey,
        ...(isUiGlobalSessionKey(target.sessionKey) ? { agentId } : {}),
        message: created.prompt,
        workContext: {
          page: "template-create",
          title: t("templatesDraft.title"),
          agentId,
          sessionKey: target.sessionKey,
          detail: { draftId: target.draftId },
        },
        deliver: false,
        idempotencyKey: generateUUID(),
      });
      if (!this.current(target, generation)) {
        return;
      }
      if (!["ok", "started", "in_flight"].includes(ack.status ?? "")) {
        throw new Error(t("templatesDraft.sendFailed"));
      }
      this.navigate(target);
      this.schedulePoll(target, generation);
    } catch (error) {
      if (this.context.gateway.snapshot.client === client && this.generation === generation) {
        const message = formatUiError(error);
        generation = this.reset(null);
        this.error = message;
        showToast({
          severity: "error",
          message,
          actionLabel: t("common.retry"),
          onAction: () => void this.start(agentId),
        });
      }
    } finally {
      if (this.context.gateway.snapshot.client === client && this.generation === generation) {
        this.busy = null;
        this.changed();
      }
    }
  }

  open(agentId: string, draftId: string, sessionKey = this.mainSessionKey(agentId)) {
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    const target = { agentId, draftId, sessionKey, client };
    this.busy = null;
    const generation = this.reset(target);
    this.navigate(target);
    this.schedulePoll(target, generation, 0);
  }

  matches(target: TemplateReviewTarget) {
    return (
      this.target?.client === this.context.gateway.snapshot.client &&
      this.target.agentId === target.agentId &&
      this.target.draftId === target.draftId &&
      this.target.sessionKey === target.sessionKey
    );
  }

  get sessionKey() {
    return this.target?.sessionKey;
  }

  hydrate(agentId: string, draftId: string, sessionKey: string) {
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    if (this.matches({ agentId, draftId, sessionKey })) {
      this.inlineReview = true;
      this.changed();
      if (this.busy === "publishing") {
        return;
      }
      if (this.publication || this.publicationIssue) {
        void this.checkPublication();
      } else {
        this.schedulePoll(this.target!, this.generation, 0);
      }
      return;
    }
    this.busy = null;
    const target = { agentId, draftId, sessionKey, client };
    const generation = this.reset(target);
    this.inlineReview = true;
    this.changed();
    this.schedulePoll(target, generation, 0);
  }

  private schedulePoll(target: Target, generation: number, delay = 2500) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      if (!this.current(target, generation)) {
        return;
      }
      if (this.publication?.publicationStatus === "pending") {
        void this.checkPublication();
      } else {
        void this.poll(target, generation);
      }
    }, delay);
  }

  private async poll(target: Target, generation: number) {
    if (!this.current(target, generation) || this.publication || this.publicationIssue) {
      return;
    }
    try {
      const draft = await target.client.request<TemplatesDraftsReadResult>(
        "templates.drafts.read",
        {
          agentId: target.agentId,
          draftId: target.draftId,
        },
      );
      if (!this.current(target, generation)) {
        return;
      }
      if (draft.revision !== this.seenRevision) {
        if (this.seenRevision !== null) {
          this.choices = null;
          this.reviewCurrent = false;
        }
        this.seenRevision = draft.revision;
        if (hasCompleteScope(draft.content)) {
          await this.refreshReview(target, generation);
        }
      }
    } catch (error) {
      if (this.current(target, generation)) {
        this.error = formatUiError(error);
        this.changed();
      }
    } finally {
      if (this.current(target, generation) && !this.publication && !this.publicationIssue) {
        this.schedulePoll(target, generation);
      }
    }
  }

  private async refreshReview(target: Target, generation: number) {
    if (!this.current(target, generation)) {
      return;
    }
    this.busy = "reviewing";
    const request = ++this.reviewRequest;
    this.changed();
    try {
      const result = await target.client.request<TemplatesDraftsReviewResult>(
        "templates.drafts.review",
        {
          agentId: target.agentId,
          draftId: target.draftId,
          ...(this.choices ? { choices: this.choices } : {}),
        },
      );
      if (!this.current(target, generation) || request !== this.reviewRequest) {
        return;
      }
      this.review = result;
      this.reviewCurrent = true;
      this.choices ??= {
        name: result.name.split("/").at(-1) ?? result.name,
        displayName: result.displayName,
        description: result.description,
        excluded: result.items.filter((item) => !item.included).map((item) => item.id),
      };
      this.error = null;
    } catch (error) {
      if (this.current(target, generation) && request === this.reviewRequest) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target, generation) && request === this.reviewRequest) {
        this.busy = null;
        this.changed();
      }
    }
  }

  async publish() {
    const target = this.target;
    const review = this.review;
    const choices = this.choices;
    if (
      !target ||
      !review ||
      !choices ||
      !this.reviewCurrent ||
      this.busy ||
      this.publication ||
      this.publicationIssue === "unconfirmed"
    ) {
      return;
    }
    if (!canCreateTemplateDraft(this.context)) {
      this.error = t("templatesDraft.reviewUnavailable");
      this.changed();
      return;
    }
    const generation = this.generation;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.publicationReviewToken = review.reviewToken;
    this.publicationIssue = null;
    this.busy = "publishing";
    this.reviewCurrent = false;
    this.changed();
    try {
      const result = await target.client.request<TemplatesDraftsPublishResult>(
        "templates.drafts.publish",
        {
          agentId: target.agentId,
          draftId: target.draftId,
          reviewToken: review.reviewToken,
          choices,
        },
      );
      if (this.current(target, generation)) {
        this.publication = result;
        this.publicationAttemptId = result.attemptId;
        this.error = null;
      }
    } catch (error) {
      if (this.current(target, generation)) {
        const effect =
          error instanceof GatewayRequestError
            ? asOptionalRecord(asOptionalRecord(error.details)?.templatePublication)?.effect
            : undefined;
        // A lost transport is not evidence that the registry write did not happen.
        this.publicationIssue = effect === "none" ? "failed" : "unconfirmed";
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target, generation)) {
        this.busy = null;
        if (this.publication?.publicationStatus === "pending") {
          this.schedulePoll(target, generation, 5000);
        }
        this.changed();
      }
    }
  }

  async checkPublication() {
    const target = this.target;
    const review = this.review;
    if (!target || !review || this.busy || !canCreateTemplateDraft(this.context)) {
      return;
    }
    const generation = this.generation;
    this.busy = "reviewing";
    this.changed();
    try {
      const result = await target.client.request<TemplatesDraftsReviewResult>(
        "templates.drafts.review",
        {
          agentId: target.agentId,
          draftId: target.draftId,
          choices: this.choices ?? undefined,
          checkPublication: true,
          reviewToken: this.publicationReviewToken ?? review.reviewToken,
          ...(this.publicationAttemptId ? { attemptId: this.publicationAttemptId } : {}),
        },
      );
      if (!this.current(target, generation)) {
        return;
      }
      const receipt = result.publicationState;
      if (receipt?.status === "published" || receipt?.status === "pending") {
        this.publication = receipt.publication;
        this.publicationIssue = null;
        this.error = null;
      } else if (receipt?.status === "failed") {
        this.publication = null;
        this.publicationIssue = "failed";
        this.error = t("templatesDraft.registryFailed", { reason: receipt.reason });
      } else {
        this.publicationIssue = "unconfirmed";
        this.publication = null;
      }
    } catch (error) {
      if (this.current(target, generation)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target, generation)) {
        this.busy = null;
        this.changed();
        if (this.publication?.publicationStatus === "pending") {
          this.schedulePoll(target, generation, 5000);
        }
      }
    }
  }

  retryReview() {
    if (this.publicationIssue === "unconfirmed") {
      return;
    }
    this.publicationIssue = null;
    const target = this.target;
    if (target) {
      void this.refreshReview(target, this.generation);
    }
  }

  async readPackagePreview(item: TemplateDraftReviewItem): Promise<TemplatePackagePreview | null> {
    const target = this.target;
    const review = this.review;
    const generation = this.generation;
    if (!target || !review?.items.includes(item) || !item.requirement) {
      return null;
    }
    const requirement = item.requirement;
    if (requirement.source === "bundled") {
      return {
        content:
          item.kind === "skill"
            ? review.files.find((file) => file.path === `${requirement.path}/SKILL.md`)?.content
            : undefined,
      };
    }
    const { ref, version } = requirement;
    let preview: TemplatePackagePreview;
    if (item.kind === "skill") {
      const result = await target.client.request<{
        skill?: { summary?: string | null } | null;
        card?: { status: "available"; content: string } | { status: "unavailable" };
      }>("skills.detail", { slug: ref, version });
      preview = {
        description: result.skill?.summary,
        content: result.card?.status === "available" ? result.card.content : undefined,
      };
    } else if (item.kind === "plugin") {
      // Catalog IDs are the Gateway's ch_ + base64url encoding of the validated package ref.
      const id =
        "ch_" +
        bytesToBase64(new TextEncoder().encode(ref))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/[=]+$/u, "");
      const result = await target.client.request<{
        plugin: { catalog: { summary?: string } };
        detail: {
          origin: string;
          packageName?: string;
          selectedRelease?: { version: string } | null;
          remoteError?: string;
        };
      }>("plugins.catalog.get", { id, version });
      preview =
        result.detail.origin === "clawhub" &&
        result.detail.packageName === ref &&
        result.detail.selectedRelease?.version === version &&
        !result.detail.remoteError
          ? { description: result.plugin.catalog.summary }
          : {};
    } else {
      return null;
    }
    return this.current(target, generation) && this.review === review ? preview : null;
  }

  private retirePendingStart() {
    const owner = templateCreatorOwner(this.context);
    if (owner.flow === this) {
      owner.pending = null;
    }
  }
}

export function templateCreatorFlow(context: ApplicationContext, target?: TemplateReviewTarget) {
  const owner = templateCreatorOwner(context);
  if (target) {
    const flows = (owner.inlineFlows ??= new Map());
    const key = JSON.stringify([target.agentId, target.draftId, target.sessionKey]);
    let flow = flows.get(key) ?? (owner.flow?.matches(target) ? owner.flow : undefined);
    if (!flow) {
      flow = new TemplateCreatorFlow(context);
    }
    flows.set(key, flow);
    return flow;
  }
  if (!owner.flow || owner.flow.inlineReview) {
    owner.flow = new TemplateCreatorFlow(context);
    owner.publish();
  }
  return owner.flow;
}
