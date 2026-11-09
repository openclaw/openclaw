import { createLazyImportLoader } from "../../../../src/shared/lazy-promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { showToast } from "../../lib/toast.ts";
import {
  templateCreatorOwner,
  type CreatorOwner,
  type TemplateReviewTarget,
} from "./creator-publication.ts";
import { canCreateTemplateDraft } from "./draft-navigation.ts";

const runtime = createLazyImportLoader(() => import("./creator-flow.ts"));

async function loadTemplateCreator(context: ApplicationContext, owner: CreatorOwner) {
  // One waiter reads the latest slot after loading; replaced connections must not
  // survive in one suspended async frame per click. Issued writes own their lifetime.
  const result = await runtime.load().then(
    (loaded) => ({ loaded }),
    (error: unknown) => ({ error }),
  );
  owner.loading = false;
  const pending = owner.pending;
  if (!pending) {
    return;
  }
  const { agentId, client, revision } = pending;
  const isCurrent = () =>
    owner.pending === pending &&
    context.gateway.snapshot.client === client &&
    context.gateway.connectionRevision === revision &&
    canCreateTemplateDraft(context);
  try {
    if (isCurrent()) {
      if ("error" in result) {
        throw result.error;
      }
      const flow = result.loaded.templateCreatorFlow(context);
      if (isCurrent()) {
        if (pending.review) {
          flow.open(agentId, pending.review.draftId, pending.review.sessionKey);
        } else {
          await flow.start(agentId);
        }
      }
    }
  } catch (error) {
    if (isCurrent()) {
      showToast({
        severity: "error",
        message: formatUiError(error),
        actionLabel: t("common.retry"),
        onAction: () => requestTemplateCreator(context, agentId, pending.review),
      });
    }
  } finally {
    if (owner.pending === pending) {
      owner.pending = null;
    }
  }
}

function requestTemplateCreator(
  context: ApplicationContext,
  agentId: string,
  review?: Omit<TemplateReviewTarget, "agentId">,
) {
  const client = context.gateway.snapshot.client;
  if (!client || !canCreateTemplateDraft(context)) {
    return;
  }
  const owner = templateCreatorOwner(context);
  const revision = context.gateway.connectionRevision;
  if (
    !review &&
    (owner.flow?.busy === "starting" ||
      (owner.pending?.client === client && owner.pending.revision === revision))
  ) {
    return;
  }
  // Claim before yielding; direct route open/start can retire this exact intent.
  owner.pending = { agentId, client, revision, ...(review ? { review } : {}) };
  if (!owner.loading) {
    owner.loading = true;
    void loadTemplateCreator(context, owner);
  }
}

/** Presentation only: the person reviews and explicitly publishes through the existing owner. */
export function openTemplateCreator(context: ApplicationContext, target: TemplateReviewTarget) {
  requestTemplateCreator(context, target.agentId, {
    draftId: target.draftId,
    sessionKey: target.sessionKey,
  });
}

export function templateCreatorAction(context: ApplicationContext, agentId: string | undefined) {
  if (!agentId || !canCreateTemplateDraft(context)) {
    return undefined;
  }
  return () => requestTemplateCreator(context, agentId);
}
