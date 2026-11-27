import { createLazyImportLoader } from "../../../../src/shared/lazy-promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
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
  type CreatorOwner,
  type TemplateReviewTarget,
} from "./creator-publication.ts";
import { canCreateTemplateDraft, templateDraftUnavailableReason } from "./draft-navigation.ts";

registerEnglishCatalog(registerAgentsHomeEnglish);

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
  const unavailable = templateDraftUnavailableReason(context);
  if (!client || unavailable) {
    if (review && unavailable !== "loading") {
      showToast({
        severity: "warning",
        message: t(
          unavailable === "disabled"
            ? "templatesDraft.reviewDisabled"
            : "templatesDraft.reviewUnavailable",
        ),
      });
    }
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

/** An ordinary chat request in the agent's main session; the create-template skill owns the rest. */
export async function shareAgentAsTemplate(context: ApplicationContext, agentId: string) {
  const client = context.gateway.snapshot.client;
  if (!client) {
    return;
  }
  const sessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  });
  const idempotencyKey = generateUUID();
  // Retry repeats this request on this connection, so an accepted send is not sent twice.
  // After the connection is replaced Retry does nothing; Share again starts a new request.
  const send = async () => {
    if (context.gateway.snapshot.client !== client) {
      return;
    }
    try {
      await client.request("chat.send", {
        sessionKey,
        ...(isUiGlobalSessionKey(sessionKey) ? { agentId } : {}),
        message: t("agentChip.shareTemplatePrompt"),
        deliver: false,
        idempotencyKey,
      });
    } catch (error) {
      if (context.gateway.snapshot.client === client) {
        showToast({
          severity: "error",
          message: formatUiError(error),
          actionLabel: t("common.retry"),
          onAction: () => void send(),
        });
      }
      return;
    }
    if (context.gateway.snapshot.client === client) {
      context.navigate(
        "chat",
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey,
          agentId,
          navigationKey: sessionKey,
        }).options,
      );
    }
  };
  await send();
}
