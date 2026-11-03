import type {
  TemplateDraftReviewChoices,
  TemplatesDraftsCreateResult,
  TemplatesDraftsPublishResult,
  TemplatesDraftsReadResult,
  TemplatesDraftsReviewResult,
} from "@openclaw/gateway-protocol";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { registerTemplateCreatorEnglish } from "../../i18n/locales/en-template-creator.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { templateCreatorOwner, type TemplateCreator } from "./creator-publication.ts";

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
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reviewRequest = 0;
  private seenRevision: string | null = null;
  busy: "starting" | "reviewing" | "publishing" | null = null;
  review: TemplatesDraftsReviewResult | null = null;
  reviewRead: { result: Promise<void> } | null = null;
  reviewCurrent = false;
  choices: TemplateDraftReviewChoices | null = null;
  modalOpen = false;
  publication: TemplatesDraftsPublishResult | null = null;
  error: string | null = null;
  presentationLifetime = Promise.withResolvers<void>();

  get hasActiveDraft() {
    return this.target !== null;
  }

  constructor(private readonly context: ApplicationContext) {
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
    this.presentationLifetime.resolve();
    this.presentationLifetime = Promise.withResolvers<void>();
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
    if (this.editTimer) {
      clearTimeout(this.editTimer);
    }
    this.target = target;
    this.seenRevision = null;
    this.review = null;
    this.reviewRead = null;
    this.reviewCurrent = false;
    this.choices = null;
    this.modalOpen = false;
    this.publication = null;
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
    this.busy = "starting";
    this.error = null;
    this.changed();
    try {
      const created = await client.request<TemplatesDraftsCreateResult>("templates.drafts.create", {
        agentId,
      });
      if (this.context.gateway.snapshot.client !== client) {
        return;
      }
      const target = {
        agentId,
        draftId: created.draftId,
        sessionKey: this.mainSessionKey(agentId),
        client,
      };
      const generation = this.reset(target);
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
      if (this.context.gateway.snapshot.client === client) {
        const message = formatUiError(error);
        this.reset(null);
        this.error = message;
        showToast({
          message,
          actionLabel: t("common.retry"),
          onAction: () => void this.start(agentId),
        });
      }
    } finally {
      if (this.context.gateway.snapshot.client === client) {
        this.busy = null;
        this.changed();
      }
    }
  }

  open(agentId: string, draftId: string) {
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    const target = { agentId, draftId, sessionKey: this.mainSessionKey(agentId), client };
    const generation = this.reset(target);
    this.navigate(target);
    this.schedulePoll(target, generation, 0);
  }

  private schedulePoll(target: Target, generation: number, delay = 2500) {
    this.pollTimer = setTimeout(() => void this.poll(target, generation), delay);
  }

  private async poll(target: Target, generation: number) {
    if (!this.current(target, generation) || this.publication) {
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
      if (this.current(target, generation) && !this.publication) {
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
    const pending = (async () => {
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
      this.modalOpen = true;
      this.error = null;
    })();
    this.reviewRead = { result: pending };
    this.changed();
    try {
      await pending;
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

  updateChoices(next: TemplateDraftReviewChoices) {
    const target = this.target;
    if (!target || !this.choices) {
      return;
    }
    this.choices = next;
    this.reviewCurrent = false;
    this.changed();
    if (this.editTimer) {
      clearTimeout(this.editTimer);
    }
    const generation = this.generation;
    this.editTimer = setTimeout(() => void this.refreshReview(target, generation), 350);
  }

  async publish() {
    const target = this.target;
    const review = this.review;
    const choices = this.choices;
    if (!target || !review || !choices || !this.reviewCurrent || this.busy) {
      return;
    }
    const generation = this.generation;
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
        this.modalOpen = false;
        this.error = null;
        showToast({
          message: t(
            result.publicationStatus === "published"
              ? "templatesDraft.published"
              : "templatesDraft.pending",
          ),
          actionLabel: t("templatesDraft.viewPublication"),
          onAction: () => openExternalUrlSafe(result.url),
        });
      }
    } catch (error) {
      if (this.current(target, generation)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.current(target, generation)) {
        this.busy = null;
        this.changed();
      }
    }
  }

  close() {
    this.retirePresentation();
    this.modalOpen = false;
    this.changed();
  }

  reopen() {
    if (this.review) {
      this.modalOpen = true;
      this.changed();
    }
  }

  retryReview() {
    const target = this.target;
    if (target) {
      void this.refreshReview(target, this.generation);
    }
  }

  private retirePendingStart() {
    const owner = templateCreatorOwner(this.context);
    if (owner.flow === this) {
      owner.pending = null;
    }
  }
}

export function templateCreatorFlow(context: ApplicationContext) {
  const owner = templateCreatorOwner(context);
  if (!owner.flow) {
    owner.flow = new TemplateCreatorFlow(context);
    owner.publish();
  }
  return owner.flow;
}
