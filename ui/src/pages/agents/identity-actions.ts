import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { updateAgentIdentity } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { assertUploadsEnabled, uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { fileToAvatarDataUrl, type AvatarDataUrlResult } from "./avatar-image.ts";
import type { AgentIdentityDraft } from "./panels-overview.tsx";

const AVATAR_REJECTION_MESSAGE_KEYS = {
  unusable: "agents.identity.imageUnusable",
  "too-detailed": "agents.identity.imageTooDetailed",
} as const satisfies Record<Extract<AvatarDataUrlResult, { ok: false }>["reason"], string>;

type AgentIdentityEditorHost = {
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityError: string | null;
};

const avatarSelections = new WeakMap<
  AgentIdentityEditorHost,
  { pending: Promise<boolean> | null }
>();

export function resetIdentityDraft(host: AgentIdentityEditorHost) {
  avatarSelections.delete(host);
  host.identityDraft = { name: null, emoji: null, avatar: null };
  host.identitySaving = false;
  host.identityError = null;
}

export function setIdentityDraftField(
  host: AgentIdentityEditorHost,
  field: "name" | "emoji",
  value: string,
) {
  host.identityDraft = { ...host.identityDraft, [field]: value };
  host.identityError = null;
}

export function selectIdentityAvatar(
  host: AgentIdentityEditorHost,
  file: File,
  config?: ApplicationConfigCapability,
) {
  const selection: { pending: Promise<boolean> | null } = { pending: null };
  avatarSelections.set(host, selection);
  if (!uploadsEnabled(config)) {
    host.identityError = uploadsDisabledMessage();
    return;
  }
  selection.pending = fileToAvatarDataUrl(file, config)
    .then((result) => {
      if (avatarSelections.get(host) !== selection) {
        return false;
      }
      if (!uploadsEnabled(config)) {
        host.identityError = uploadsDisabledMessage();
        return false;
      }
      if (result.ok) {
        host.identityDraft = { ...host.identityDraft, avatar: result.dataUrl };
        host.identityError = null;
      } else {
        host.identityError = t(AVATAR_REJECTION_MESSAGE_KEYS[result.reason]);
      }
      return result.ok;
    })
    .catch((error: unknown) => {
      if (avatarSelections.get(host) === selection) {
        host.identityError = formatUiError(error);
      }
      return false;
    })
    .finally(() => {
      selection.pending = null;
    });
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
  host.identitySaving = true;
  host.identityError = null;
  try {
    const selection = avatarSelections.get(host);
    if (selection?.pending) {
      // Save owns the chosen image too, even while the browser is still decoding it.
      const ready = await selection.pending;
      if (!params.isCurrent() || avatarSelections.get(host) !== selection || !ready) {
        return;
      }
    }
    const draft = host.identityDraft;
    // Set/replace only: agents.update has no explicit clear operation. Keep a
    // blank edit visible and unsaved instead of pretending it removed a field.
    const name = draft.name?.trim();
    const emoji = draft.emoji?.trim();
    const avatar = draft.avatar ?? undefined;
    if ((draft.name !== null && !name) || (draft.emoji !== null && !emoji)) {
      return;
    }
    if (!name && !emoji && !avatar) {
      resetIdentityDraft(host);
      return;
    }
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
      resetIdentityDraft(host);
      params.onSaved();
      host.identityError = refreshErrors.length > 0 ? refreshErrors.join(" ") : null;
    }
  } catch (err) {
    if (params.isCurrent()) {
      host.identityError = formatUiError(err);
    }
  } finally {
    if (params.isCurrent()) {
      host.identitySaving = false;
    }
  }
}
