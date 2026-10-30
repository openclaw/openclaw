import { action, createOptimistic, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { createTimeout } from "../../lib/reactive/timers.ts";
import type { GeneratedAvatar } from "./avatar-picker.tsx";
import {
  identityDraftStatus,
  saveIdentityDraft,
  selectIdentityAvatar,
  setIdentityAvatar,
  setIdentityDraftField,
} from "./identity-actions.ts";
import type { RetainedIdentitySave } from "./selection-drafts.ts";

type IdentityOwners = Pick<ApplicationContext, "agents" | "agentIdentity">;
type IdentityHost = Parameters<typeof saveIdentityDraft>[0]["host"] & {
  client: GatewayBrowserClient | null;
  agentsSelectedId: string | null;
  requestGeneration: number;
};

/** Coordinates editor work; identity-actions retains mutation authority and draft settlement. */
export function createAgentIdentityEditor(
  context: IdentityOwners & Pick<ApplicationContext, "config" | "runtimeConfig">,
  state: IdentityHost,
  options: {
    snapshot: () => ApplicationGatewaySnapshot | null;
    saves: () => Map<string, RetainedIdentitySave>;
    retired: () => Promise<void>;
    canCall: (method: string) => boolean;
    isCurrent: (
      client: GatewayBrowserClient,
      generation: number,
      agentId: string,
      owners: Partial<IdentityOwners>,
    ) => boolean;
    onSaved: (agents: ApplicationContext["agents"]) => void;
  },
) {
  const [saving, setSaving] = createOptimistic(false);
  const presentSave = action(function* (completion: Promise<void>, retirement: Promise<void>) {
    if (retirement === options.retired()) {
      setSaving(true);
    }
    yield Promise.race([completion, retirement]);
  });
  const autosave = createTimeout(() => void save(), 550);

  function schedule(delay = 550) {
    autosave.cancel();
    if (identityDraftStatus(state.identityDraft) === "ready") {
      autosave.schedule(delay);
    }
  }

  async function save() {
    const client = state.client;
    const agentId = state.agentsSelectedId;
    if (!client || !agentId || !options.canCall("agents.update")) {
      return;
    }
    const activeSave = options.saves().get(agentId);
    if (activeSave?.client === client && activeSave.snapshot === options.snapshot()) {
      await activeSave.promise;
      if (state.client === client && state.agentsSelectedId === agentId) {
        schedule(0);
      }
      return;
    }
    if (state.identitySaving) {
      return;
    }
    const generation = state.requestGeneration;
    const { agents, agentIdentity } = context;
    const isCurrent = () =>
      options.isCurrent(client, generation, agentId, { agents, agentIdentity });
    const draftAtStart = state.identityDraft;
    const completion = saveIdentityDraft({
      host: state,
      config: context.config,
      expectedClient: client,
      agentId,
      agents,
      agentIdentity,
      runtimeConfig: context.runtimeConfig,
      canDispatch: () => options.canCall("agents.update") && isCurrent(),
      isCurrent,
      onSaved: () => options.onSaved(agents),
    });
    options.saves().set(agentId, { client, snapshot: options.snapshot(), promise: completion });
    // Scope changes release presentation; the owner still settles its admitted write.
    const retirement = options.retired();
    onSettled(() => {
      void presentSave(completion, retirement);
    });
    try {
      await completion;
    } finally {
      if (options.saves().get(agentId)?.promise === completion) {
        options.saves().delete(agentId);
      }
    }
    if (isCurrent() && state.identityDraft !== draftAtStart) {
      schedule(0);
    }
  }

  return {
    cancel: autosave.cancel,
    schedule,
    saving,
    forAgent(selectedAgentId: string | null) {
      const canEdit = () =>
        selectedAgentId === state.agentsSelectedId && options.canCall("agents.update");
      return {
        onIdentityFieldChange: (field: "name" | "emoji", value: string) => {
          if (canEdit()) {
            setIdentityDraftField(state, field, value);
            schedule();
          }
        },
        onIdentityAvatarSelect: (file: File) => {
          if (canEdit()) {
            selectIdentityAvatar(state, file, context.config, () => schedule(0));
          }
        },
        onIdentityAvatarSet: (dataUrl: string) => {
          if (canEdit()) {
            setIdentityAvatar(state, dataUrl, context.config);
            schedule(0);
          }
        },
        onIdentityAvatarGenerate: async (prompt: string) => {
          const client = state.client;
          const generation = state.requestGeneration;
          if (
            !client ||
            !selectedAgentId ||
            !canEdit() ||
            !options.canCall("agents.avatar.generate")
          ) {
            throw new Error(t("agents.identity.avatarPermission"));
          }
          const result = await client.request<GeneratedAvatar>(
            "agents.avatar.generate",
            { agentId: selectedAgentId, prompt },
            { timeoutMs: 100_000 },
          );
          if (!options.isCurrent(client, generation, selectedAgentId, {})) {
            throw new Error(t("agents.identity.avatarContextChanged"));
          }
          return result;
        },
        onIdentitySave: () => schedule(0),
      };
    },
  };
}
