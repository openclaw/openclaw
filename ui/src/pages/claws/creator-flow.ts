import type {
  ClawDraftReviewChoices,
  ClawsDraftsCreateResult,
  ClawsDraftsPublishResult,
  ClawsDraftsReadResult,
  ClawsDraftsReviewResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { clawDraftUrl } from "./draft-navigation.ts";

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
export class ClawCreatorFlow {
  private readonly listeners = new Set<() => void>();
  private target: Target | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reviewRequest = 0;
  private seenRevision: string | null = null;
  busy: "starting" | "reviewing" | "publishing" | null = null;
  review: ClawsDraftsReviewResult | null = null;
  reviewCurrent = false;
  choices: ClawDraftReviewChoices | null = null;
  modalOpen = false;
  publication: ClawsDraftsPublishResult | null = null;
  error: string | null = null;

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

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) {
      listener();
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
    this.busy = "starting";
    this.error = null;
    this.changed();
    try {
      const created = await client.request<ClawsDraftsCreateResult>("claws.drafts.create", {
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
      const reviewUrl = clawDraftUrl(this.context.basePath, target);
      const message = `${created.prompt}\nReview: [Create a Claw](${reviewUrl})`;
      const ack = await client.request<{ status?: string }>("chat.send", {
        sessionKey: target.sessionKey,
        ...(isUiGlobalSessionKey(target.sessionKey) ? { agentId } : {}),
        message,
        deliver: false,
        idempotencyKey: generateUUID(),
      });
      if (!this.current(target, generation)) {
        return;
      }
      if (!["ok", "started", "in_flight"].includes(ack.status ?? "")) {
        throw new Error(t("clawsDraft.sendFailed"));
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
      const draft = await target.client.request<ClawsDraftsReadResult>("claws.drafts.read", {
        agentId: target.agentId,
        draftId: target.draftId,
      });
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
    this.changed();
    try {
      const result = await target.client.request<ClawsDraftsReviewResult>("claws.drafts.review", {
        agentId: target.agentId,
        draftId: target.draftId,
        ...(this.choices ? { choices: this.choices } : {}),
      });
      if (!this.current(target, generation) || request !== this.reviewRequest) {
        return;
      }
      this.review = result;
      this.reviewCurrent = true;
      this.choices ??= {
        name: result.name.split("/").at(-1) ?? result.name,
        description: result.description,
        excluded: result.items.filter((item) => !item.included).map((item) => item.id),
      };
      this.modalOpen = true;
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

  updateChoices(next: ClawDraftReviewChoices) {
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
      const result = await target.client.request<ClawsDraftsPublishResult>("claws.drafts.publish", {
        agentId: target.agentId,
        draftId: target.draftId,
        reviewToken: review.reviewToken,
        choices,
      });
      if (this.current(target, generation)) {
        this.publication = result;
        this.modalOpen = false;
        this.error = null;
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
}

const flows = new WeakMap<ApplicationContext, ClawCreatorFlow>();

export function clawCreatorFlow(context: ApplicationContext) {
  let flow = flows.get(context);
  if (!flow) {
    flow = new ClawCreatorFlow(context);
    flows.set(context, flow);
  }
  return flow;
}
