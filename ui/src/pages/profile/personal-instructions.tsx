import { createSignal, onCleanup, Show } from "solid-js";
import type {
  UsersPersonalFileGetResult,
  UsersPersonalFileSetResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { SettingsEmpty, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerPersonalInstructionsEnglish } from "../../i18n/locales/en-personal-instructions.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

registerEnglishCatalog(registerPersonalInstructionsEnglish);

class PersonalInstructionsState {
  agentId = "";
  file: UsersPersonalFileGetResult | null = null;
  draft = "";
  busy: "load" | "save" | null = null;
  error: string | null = null;
  saved = false;
  client: GatewayBrowserClient | null = null;
  profileId: string | null = null;
  connectionId: string | null = null;
  gatewayUrl: string | null = null;
  available = false;
  multipleProfiles = false;
  drafts = new Map<string, { file: UsersPersonalFileGetResult; content: string }>();

  constructor(
    readonly context: ApplicationContext,
    readonly publish: () => void,
  ) {}

  get agents() {
    return this.context.agents.state?.agentsList?.agents ?? [];
  }
  get dirty() {
    return this.file !== null && this.draft !== this.file.content;
  }

  dispose() {
    this.client = null;
    this.available = false;
  }

  syncContext() {
    const snapshot = this.context.gateway.snapshot;
    const connected = snapshot.phase === "connected";
    // Hello can arrive before profile resolution. Keep the draft private until
    // identity is known, then restore it only for the same person and Gateway.
    // A reconnect keeps the old hash so concurrent edits still conflict.
    const profileId = snapshot.selfUser?.id ?? this.profileId;
    const gatewayUrl = this.context.gateway.connection.gatewayUrl;
    const connectionId = snapshot.hello?.server?.connId ?? null;
    this.multipleProfiles = snapshot.hello?.policy?.hasMultipleSessionSharingIdentities === true;
    const available =
      connected &&
      this.multipleProfiles &&
      Boolean(snapshot.selfUser?.id) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    const identityChanged = profileId !== this.profileId || gatewayUrl !== this.gatewayUrl;
    const sourceChanged =
      identityChanged ||
      snapshot.client !== this.client ||
      connectionId !== this.connectionId ||
      available !== this.available;
    if (sourceChanged) {
      this.client = snapshot.client;
      this.connectionId = connectionId;
      this.gatewayUrl = gatewayUrl;
      this.profileId = profileId;
      this.available = available;
      if (identityChanged) {
        this.file = null;
        this.draft = "";
        this.agentId = "";
        this.drafts.clear();
      }
    }
    // Settings owns the target. Keep unsaved drafts scoped to this person,
    // Gateway and agent rather than blocking or reverting the global selector.
    const selectedId = this.context.settingsAgentSelection.state.selectedId;
    const nextAgentId = this.agents.some((agent) => agent.id === selectedId) ? selectedId! : "";
    const agentChanged = nextAgentId !== this.agentId;
    if (agentChanged) {
      if (this.dirty && this.file) {
        this.drafts.set(this.agentId, { file: this.file, content: this.draft });
      } else {
        this.drafts.delete(this.agentId);
      }
      this.agentId = nextAgentId;
      const pending = this.drafts.get(nextAgentId);
      this.drafts.delete(nextAgentId);
      this.file = pending?.file ?? null;
      this.draft = pending?.content ?? "";
    }
    if (sourceChanged || agentChanged) {
      this.busy = null;
      this.error = null;
      this.saved = false;
    }
    if (this.available && this.agentId && !this.dirty && (sourceChanged || agentChanged)) {
      void this.load();
    }
    this.publish();
  }

  async load() {
    const client = this.client;
    const agentId = this.agentId;
    const profileId = this.profileId;
    if (!client || !this.available || !agentId || this.busy) {
      return;
    }
    await this.requestFile("load", { agentId, profileId }, () =>
      client.request<UsersPersonalFileGetResult>("users.personalFile.get", { agentId }),
    );
  }

  async save() {
    const client = this.client;
    const file = this.file;
    if (
      !client ||
      !file ||
      !this.available ||
      this.busy ||
      !this.dirty ||
      file.agentId !== this.agentId ||
      this.draft.length > 4000 ||
      !this.agents.some((agent) => agent.id === file.agentId)
    ) {
      return;
    }
    const content = this.draft;
    await this.requestFile("save", file, () =>
      client.request<UsersPersonalFileSetResult>("users.personalFile.set", {
        agentId: file.agentId,
        content,
        expectedHash: file.hash,
      }),
    );
  }

  async requestFile(
    operation: "load" | "save",
    target: { agentId: string; profileId: string | null },
    request: () => Promise<UsersPersonalFileGetResult>,
  ) {
    const client = this.client;
    const connectionId = this.connectionId;
    const draft = this.draft;
    const isCurrent = () =>
      this.available &&
      this.client === client &&
      this.connectionId === connectionId &&
      this.agentId === target.agentId &&
      this.profileId === target.profileId;
    this.busy = operation;
    this.error = null;
    this.saved = false;
    this.publish();
    try {
      const result = await request();
      if (!isCurrent()) {
        return;
      }
      if (result.agentId !== target.agentId || result.profileId !== target.profileId) {
        throw new Error(t("profilePage.personalInstructions.contextChanged"));
      }
      this.file = result;
      if (this.draft === draft) {
        this.busy = null;
        this.draft = result.content;
      }
      this.drafts.delete(result.agentId);
      this.saved = operation === "save" && this.draft === result.content;
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        if (this.draft === draft) {
          this.busy = null;
        }
        this.publish();
      }
    }
  }

  reload() {
    if (this.dirty && !window.confirm(t("profilePage.personalInstructions.discard"))) {
      return;
    }
    void this.load();
  }
}

function PersonalInstructionsContent() {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new PersonalInstructionsState(context, () => setRevision((value) => value + 1));
  const view = () => {
    revision();
    return state;
  };
  const sync = () => state.syncContext();
  const stops = [
    context.gateway.subscribe(sync),
    context.agents.subscribe(sync),
    context.settingsAgentSelection.subscribe(sync),
  ];
  state.syncContext();
  void context.agents.ensureList();
  onCleanup(() => {
    stops.forEach((stop) => stop());
    state.dispose();
  });

  return (
    <Show when={view().multipleProfiles}>
      <div id={PROFILE_SETTINGS_TARGET_IDS.personalInstructions}>
        <SettingsSection
          title={t("profilePage.personalInstructions.title")}
          description={t("profilePage.personalInstructions.description")}
        >
          <Show
            when={view().available}
            fallback={<SettingsEmpty message={t("profilePage.personalInstructions.signIn")} />}
          >
            <Show
              when={view().agents.length}
              fallback={<SettingsEmpty message={t("profilePage.personalInstructions.noAgents")} />}
            >
              <div
                class="personal-instructions"
                aria-busy={view().busy !== null ? "true" : "false"}
              >
                <Show when={view().file}>
                  <textarea
                    id="personal-instructions-content"
                    class="settings-input personal-instructions__editor"
                    rows={7}
                    value={view().draft}
                    disabled={view().busy !== null}
                    aria-label={t("profilePage.personalInstructions.title")}
                    aria-describedby="personal-instructions-guidance"
                    onInput={(event) => {
                      state.draft = event.currentTarget.value;
                      state.saved = false;
                      state.publish();
                    }}
                  />
                  <div id="personal-instructions-guidance" class="settings-row__desc">
                    {t("profilePage.personalInstructions.guidance", {
                      count: String(view().draft.length),
                    })}
                    {view().file?.missing
                      ? ` ${t("profilePage.personalInstructions.missing")}`
                      : null}
                  </div>
                  <Show when={view().draft.length > 4000}>
                    <div role="alert">{t("profilePage.personalInstructions.tooLong")}</div>
                  </Show>
                </Show>
                <Show when={view().error}>
                  <div class="personal-instructions__error" role="alert">
                    {view().error} {t("profilePage.personalInstructions.failureHint")}
                  </div>
                </Show>
                <div class="personal-instructions__actions">
                  <button
                    class="btn"
                    disabled={
                      !view().file ||
                      !view().dirty ||
                      view().busy !== null ||
                      view().draft.length > 4000 ||
                      !view().agents.some((agent) => agent.id === view().agentId)
                    }
                    onClick={() => void state.save()}
                  >
                    {view().busy === "save" ? t("common.saving") : t("common.save")}
                  </button>
                  <Show when={view().error}>
                    <button
                      class="btn"
                      disabled={view().busy !== null}
                      onClick={() => state.reload()}
                    >
                      {t("profilePage.personalInstructions.reload")}
                    </button>
                  </Show>
                  <span class="settings-row__desc" role="status">
                    {view().dirty
                      ? t("profilePage.personalInstructions.dirty")
                      : view().saved
                        ? t("profilePage.personalInstructions.saved")
                        : null}
                  </span>
                </div>
              </div>
            </Show>
          </Show>
        </SettingsSection>
      </div>
    </Show>
  );
}

export const PersonalInstructions = defineSolidBridge(
  "openclaw-personal-instructions",
  PersonalInstructionsContent,
  { properties: {} },
);
