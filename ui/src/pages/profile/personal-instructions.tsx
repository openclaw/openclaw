import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
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
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

registerEnglishCatalog(registerPersonalInstructionsEnglish);

type PersonalFileResult = UsersPersonalFileGetResult | null;

class PersonalInstructionsState {
  agentId = "";
  file: UsersPersonalFileGetResult | null = null;
  draft = "";
  private busy = false;
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
    readonly presentFile: (result: PersonalFileResult | Promise<PersonalFileResult>) => void,
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
      this.busy = false;
      this.saved = false;
      this.presentFile(this.file);
    }
    if (this.available && this.agentId && !this.dirty && (sourceChanged || agentChanged)) {
      this.load();
    }
    this.publish();
  }

  load() {
    const client = this.client;
    const agentId = this.agentId;
    const profileId = this.profileId;
    if (!client || !this.available || !agentId || this.busy) {
      return;
    }
    void this.requestFile("load", { agentId, profileId }, () =>
      client.request<UsersPersonalFileGetResult>("users.personalFile.get", { agentId }),
    );
  }

  save() {
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
      return undefined;
    }
    const content = this.draft;
    return this.requestFile("save", file, () =>
      client.request<UsersPersonalFileSetResult>("users.personalFile.set", {
        agentId: file.agentId,
        content,
        expectedHash: file.hash,
      }),
    );
  }

  requestFile(
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
    this.busy = true;
    this.saved = false;
    const completion = (async () => {
      try {
        const result = await request();
        if (!isCurrent()) {
          return null;
        }
        if (result.agentId !== target.agentId || result.profileId !== target.profileId) {
          throw new Error(t("profilePage.personalInstructions.contextChanged"));
        }
        this.file = result;
        if (this.draft === draft) {
          this.busy = false;
          this.draft = result.content;
        }
        this.drafts.delete(result.agentId);
        this.saved = operation === "save" && this.draft === result.content;
        return result;
      } catch (error) {
        if (isCurrent()) {
          throw error;
        }
        return null;
      } finally {
        if (isCurrent()) {
          if (this.draft === draft) {
            this.busy = false;
          }
          this.publish();
        }
      }
    })();
    // Returning to an agent can accept its earlier save; report its failure too.
    void completion.catch(() => {
      if (isCurrent()) {
        this.presentFile(completion);
      }
    });
    this.presentFile(completion);
    this.publish();
    return completion;
  }

  reload() {
    if (this.dirty && !window.confirm(t("profilePage.personalInstructions.discard"))) {
      return;
    }
    this.load();
  }
}

export function PersonalInstructions(props: { hidden?: boolean }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [fileRequest, setFileRequest] = createSignal<
    PersonalFileResult | Promise<PersonalFileResult>
  >(null, { ownedWrite: true });
  const loadedFile = createMemo(() => Promise.resolve(fileRequest()));
  const [saving, setSaving] = createOptimistic<Promise<PersonalFileResult>>();
  const presentSave = action(function* (completion: Promise<PersonalFileResult>) {
    void setSaving(completion);
    yield completion;
  });
  const state = new PersonalInstructionsState(
    context,
    () => setRevision((value) => value + 1),
    (result) => {
      void setFileRequest(result);
    },
  );
  const save = () => {
    const completion = state.save();
    if (!completion) {
      return;
    }
    // Keep the presentation transition out of the admitted read's opening task.
    setTimeout(() => {
      if (state.available && fileRequest() === completion) {
        void presentSave(completion).catch(() => {});
      }
    }, 0);
  };
  const view = () => {
    revision();
    return state;
  };
  onSettled(() => {
    const sync = () => state.syncContext();
    const stops = [
      // Connection changes retire personal-file requests and isolate drafts by person and Gateway.
      context.gateway.subscribe(sync),
      // Roster changes reconcile the personal-file target before another read or save.
      context.agents.subscribe(sync),
      // Selection receipts preserve the old agent's draft and retire its pending file work.
      context.settingsAgentSelection.subscribe(sync),
    ];
    state.syncContext();
    void context.agents.ensureList();
    return () => {
      stops.forEach((stop) => stop());
      state.dispose();
    };
  });

  function Editor(editorProps: { file: PersonalFileResult; pending?: boolean; error?: string }) {
    return (
      <div class="personal-instructions" aria-busy={editorProps.pending ? "true" : "false"}>
        <Show when={editorProps.file && view().file}>
          <textarea
            id="personal-instructions-content"
            class="settings-input personal-instructions__editor"
            rows={7}
            value={view().draft}
            disabled={editorProps.pending}
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
            {view().file?.missing ? ` ${t("profilePage.personalInstructions.missing")}` : null}
          </div>
          <Show when={view().draft.length > 4000}>
            <div role="alert">{t("profilePage.personalInstructions.tooLong")}</div>
          </Show>
        </Show>
        <Show when={editorProps.error}>
          <div class="personal-instructions__error" role="alert">
            {editorProps.error} {t("profilePage.personalInstructions.failureHint")}
          </div>
        </Show>
        <div class="personal-instructions__actions">
          <button
            class="btn"
            disabled={
              !view().file ||
              !view().dirty ||
              editorProps.pending ||
              view().draft.length > 4000 ||
              !view().agents.some((agent) => agent.id === view().agentId)
            }
            onClick={save}
          >
            {saving() === fileRequest() ? t("common.saving") : t("common.save")}
          </button>
          <Show when={editorProps.error}>
            <button class="btn" disabled={editorProps.pending} onClick={() => state.reload()}>
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
    );
  }

  return (
    <openclaw-personal-instructions hidden={props.hidden}>
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
                fallback={
                  <SettingsEmpty message={t("profilePage.personalInstructions.noAgents")} />
                }
              >
                <Loading on={fileRequest()} fallback={<Editor file={view().file} pending />}>
                  <Errored
                    fallback={(error) => (
                      <Editor file={view().file} error={formatUiError(error())} />
                    )}
                  >
                    <Editor file={loadedFile()} pending={isPending(loadedFile)} />
                  </Errored>
                </Loading>
              </Show>
            </Show>
          </SettingsSection>
        </div>
      </Show>
    </openclaw-personal-instructions>
  );
}
