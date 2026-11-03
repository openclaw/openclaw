import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { updateAgentIdentity } from "../../lib/agents/mutations.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { assertUploadsEnabled, uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { fileToAvatarDataUrl, type AvatarDataUrlResult } from "./avatar-image.ts";

registerSettingsEnglish();

export type AgentIdentityDraft = {
  name: string | null;
  emoji: string | null;
  avatar: string | null;
};

export type AgentIdentityOutcome = { error: string } | null;

export function identityDraftStatus(draft: AgentIdentityDraft) {
  // agents.update can replace fields, but cannot clear them with a blank edit.
  if (
    (draft.name !== null && !draft.name.trim()) ||
    (draft.emoji !== null && !draft.emoji.trim())
  ) {
    return "incomplete";
  }
  return draft.name === null && draft.emoji === null && draft.avatar === null ? "empty" : "ready";
}

const AVATAR_REJECTION_MESSAGE_KEYS = {
  unusable: "agents.identity.imageUnusable",
  "too-detailed": "agents.identity.imageTooDetailed",
} as const satisfies Record<Extract<AvatarDataUrlResult, { ok: false }>["reason"], string>;

type AgentIdentityEditorHost = {
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityOutcome: Promise<AgentIdentityOutcome> | null;
};

const avatarSelections = new WeakMap<AgentIdentityEditorHost, symbol>();

export function resetIdentityDraft(host: AgentIdentityEditorHost) {
  avatarSelections.delete(host);
  host.identityDraft = { name: null, emoji: null, avatar: null };
  host.identitySaving = false;
  host.identityOutcome = null;
}

export function setIdentityDraftField(
  host: AgentIdentityEditorHost,
  field: "name" | "emoji",
  value: string,
) {
  host.identityDraft = { ...host.identityDraft, [field]: value };
  host.identityOutcome = null;
}

export function selectIdentityAvatar(
  host: AgentIdentityEditorHost,
  file: File,
  config?: ApplicationConfigCapability,
  onSelected?: () => void,
) {
  const selection = Symbol("avatar-selection");
  avatarSelections.set(host, selection);
  if (!uploadsEnabled(config)) {
    host.identityOutcome = Promise.resolve({ error: uploadsDisabledMessage() });
    return;
  }
  const completion = Promise.withResolvers<AgentIdentityOutcome>();
  host.identityOutcome = completion.promise;
  const finish = (error?: string) => {
    const outcome = error && avatarSelections.get(host) === selection ? { error } : null;
    if (outcome) {
      host.identityOutcome = completion.promise;
    }
    completion.resolve(outcome);
  };
  void fileToAvatarDataUrl(file, config)
    .then((result) => {
      if (avatarSelections.get(host) !== selection) {
        finish();
        return;
      }
      if (!uploadsEnabled(config)) {
        finish(uploadsDisabledMessage());
        return;
      }
      if (result.ok) {
        setIdentityAvatar(host, result.dataUrl, config);
        onSelected?.();
        finish();
      } else {
        finish(t(AVATAR_REJECTION_MESSAGE_KEYS[result.reason]));
      }
    })
    .catch((error: unknown) => finish(formatUiError(error)));
}

/** A rendered preset or accepted generated candidate is already size-bounded. */
export function setIdentityAvatar(
  host: AgentIdentityEditorHost,
  dataUrl: string,
  config?: ApplicationConfigCapability,
) {
  avatarSelections.delete(host);
  assertUploadsEnabled(config);
  host.identityDraft = { ...host.identityDraft, avatar: dataUrl };
  host.identityOutcome = null;
}

/** Persist the draft via agents.update, then refresh the roster and the
    identity cache so the sidebar chip and page pick up the new identity. */
export async function saveIdentityDraft(params: {
  host: AgentIdentityEditorHost;
  config?: ApplicationConfigCapability;
  expectedClient: GatewayBrowserClient;
  agentId: string;
  agents: ApplicationContext["agents"];
  agentIdentity: ApplicationContext["agentIdentity"];
  runtimeConfig: ApplicationContext["runtimeConfig"];
  canDispatch: () => boolean;
  isCurrent: () => boolean;
  onSaved: () => void;
}) {
  const { host, expectedClient, agentId, agents, agentIdentity, runtimeConfig } = params;
  const draft = host.identityDraft;
  // Set/replace only: agents.update has no explicit clear operation. Keep a
  // blank edit visible and unsaved instead of pretending it removed a field.
  const name = draft.name?.trim();
  const emoji = draft.emoji?.trim();
  const avatar = draft.avatar ?? undefined;
  if (identityDraftStatus(draft) === "incomplete") {
    return;
  }
  if (!name && !emoji && !avatar) {
    resetIdentityDraft(host);
    return;
  }
  const completion = Promise.withResolvers<AgentIdentityOutcome>();
  let failure: string | undefined;
  host.identitySaving = true;
  host.identityOutcome = completion.promise;
  try {
    if (avatar) {
      assertUploadsEnabled(params.config);
    }
    const mutation = await runtimeConfig.runExternalMutation(
      (client) => {
        if (client !== expectedClient) {
          throw new Error("Connection changed before the agent identity update started.");
        }
        if (avatar) {
          assertUploadsEnabled(params.config);
        }
        return updateAgentIdentity(client, { agentId, name, emoji, avatar });
      },
      {
        canDispatch: params.canDispatch,
        dispatchError: "Access changed before the agent identity update started.",
      },
    );
    if (!mutation.ok) {
      throw new Error(mutation.error);
    }
    const refreshErrors = mutation.refresh.ok ? [] : [mutation.refresh.error];
    agentIdentity.invalidate([agentId]);
    for (const [refresh, subject] of [
      [() => agents.refreshList(), "agent list"],
      [() => agentIdentity.ensure([agentId]), "identity"],
    ] as const) {
      try {
        await refresh();
      } catch (error) {
        refreshErrors.push(
          `Agent identity was saved, but the ${subject} refresh failed: ${formatUiError(error)}`,
        );
      }
    }
    if (params.isCurrent()) {
      host.identityDraft = {
        name: host.identityDraft.name === draft.name ? null : host.identityDraft.name,
        emoji: host.identityDraft.emoji === draft.emoji ? null : host.identityDraft.emoji,
        avatar: host.identityDraft.avatar === draft.avatar ? null : host.identityDraft.avatar,
      };
      params.onSaved();
      failure = refreshErrors.length > 0 ? refreshErrors.join(" ") : undefined;
    }
  } catch (err) {
    if (params.isCurrent()) {
      failure = formatUiError(err);
    }
  } finally {
    if (params.isCurrent()) {
      host.identitySaving = false;
      if (failure) {
        host.identityOutcome = completion.promise;
      }
    }
    completion.resolve(failure ? { error: failure } : null);
  }
}
