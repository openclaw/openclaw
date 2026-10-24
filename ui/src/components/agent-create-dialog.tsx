import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  createUniqueId,
  Errored,
  Show,
} from "solid-js";
import type { AgentsAvatarGenerateResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../app/context.ts";
import { LobsterSvg } from "../components/lobster-pet-artwork.tsx";
import { canonicalLobsterLook } from "../components/lobster-pet-identity.ts";
import { LOBSTER_PALETTE_WEIGHTS } from "../components/lobster-pet-palettes.ts";
import { Icon } from "../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../components/solid/identity-avatar.tsx";
import { registerAgentCreationEnglish } from "../i18n/locales/en-agent-creation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { t } from "../lib/reactive/i18n.ts";
import { fileToAvatarDataUrl, type AvatarDataUrlResult } from "../pages/agents/avatar-image.ts";
import {
  AvatarPicker,
  requireAvatarImage,
  type AvatarPickerActions,
  type AvatarPickerFooterState,
  type GeneratedAvatar,
} from "../pages/agents/avatar-picker.tsx";
import "../styles/agent-create-dialog.css";

registerAgentCreationEnglish();

export type AgentCreateIdentity = { name: string; avatar: string | null };

export function AgentCreateDialog(props: {
  context: ApplicationContext;
  onCancel: () => void;
  onCreate: (identity: AgentCreateIdentity) => void;
}) {
  const [name, setName] = createSignal("");
  const [avatar, setAvatar] = createSignal<string | null>(null);
  const [uploadBusy, setUploadBusy] = createOptimistic(false);
  const [uploadAttempt, setUploadAttempt] = createSignal<{ result: Promise<void> }>();
  const uploadOutcome = createMemo(() => uploadAttempt()?.result.then(() => null), {
    loadingValue: undefined,
  });
  const initialPickerFooter: AvatarPickerFooterState = {
    mode: "bot",
    canGenerate: false,
    generated: false,
    busy: false,
  };
  const [pickerActions, setPickerActions] = createSignal<AvatarPickerActions | null>(null);
  const pickerFooter = () => pickerActions()?.footerState() ?? initialPickerFooter;
  const pickerBusy = () => pickerFooter().busy;
  const draftAgentId = `bot-draft-${createUniqueId()}`;
  const dialogTitle = createMemo(() => t("agentChip.createDialogTitle"));
  const namePlaceholder = createMemo(() => t("agentChip.createDialogName"));
  const draftIdentity = createMemo(() => ({
    id: draftAgentId,
    name: name().trim() || dialogTitle(),
    avatar: avatar() ?? undefined,
  }));
  const mainAgentId = () => props.context.agents.state.agentsList?.defaultId;
  const needsGeneration = () => pickerFooter().mode === "generate" && !pickerFooter().generated;
  const primaryDisabled = createMemo(
    () =>
      pickerBusy() ||
      uploadBusy() ||
      (needsGeneration() ? !pickerFooter().canGenerate : !name().trim()),
  );

  async function generateAvatar(prompt: string): Promise<GeneratedAvatar> {
    const client = props.context.gateway.snapshot.client;
    const agentId = mainAgentId();
    if (
      !client ||
      !agentId ||
      !canCallGatewayMethod(
        props.context.gateway.snapshot,
        "agents.avatar.generate",
        "operator.admin",
      )
    ) {
      throw new Error(t("agents.identity.avatarPermission"));
    }
    return await client.request<AgentsAvatarGenerateResult>(
      "agents.avatar.generate",
      { agentId, prompt },
      { timeoutMs: 100_000 },
    );
  }

  const uploadAvatar = action(function* (
    file: File,
  ): Generator<Promise<AvatarDataUrlResult>, void, AvatarDataUrlResult> {
    setUploadBusy(true);
    const result = yield fileToAvatarDataUrl(file, props.context.config);
    setAvatar(requireAvatarImage(result));
  });

  let submitted = false;
  function submit() {
    if (needsGeneration()) {
      if (!pickerBusy() && !uploadBusy() && pickerFooter().canGenerate) {
        void pickerActions()?.generate();
      }
      return;
    }
    const submittedName = name().trim();
    if (submitted || !submittedName || pickerBusy() || uploadBusy()) {
      return;
    }
    submitted = true;
    props.onCreate({ name: submittedName, avatar: avatar() });
  }

  return (
    <openclaw-modal-dialog
      class="agent-create-modal"
      label={dialogTitle()}
      onModal-cancel={() => props.onCancel()}
    >
      <form
        class="agent-create-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div class="agent-create-dialog__header">
          <h2>{dialogTitle()}</h2>
          <button
            type="button"
            class="agent-create-dialog__close"
            aria-label={t("common.close")}
            onClick={() => props.onCancel()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="agent-create-dialog__body">
          <div class="agent-create-dialog__preview">
            <Show
              when={avatar()}
              fallback={
                <div class="agent-create-dialog__ghost avatar-picker__ghost avatar-picker__sprite lobster-pet">
                  <LobsterSvg
                    look={canonicalLobsterLook(LOBSTER_PALETTE_WEIGHTS[0][0])}
                    standalone
                  />
                </div>
              }
            >
              <AgentIdentityAvatar agent={draftIdentity()} />
            </Show>
          </div>
          <label class="agent-create-dialog__name">
            <span class="sr-only">{t("agents.identity.name")}</span>
            <input
              name="name"
              type="text"
              autocomplete="off"
              maxlength="64"
              placeholder={namePlaceholder()}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              autofocus
            />
          </label>
          <AvatarPicker
            agentId={draftAgentId}
            avatar={avatar()}
            disabled={uploadBusy()}
            onSelect={(nextAvatar) => {
              setAvatar(nextAvatar);
              setUploadAttempt(undefined);
            }}
            onUpload={(file) => {
              const result = uploadAvatar(file);
              // The dialog can close before its error slot observes the result.
              void result.catch(() => undefined);
              setUploadAttempt({ result });
            }}
            onGenerate={generateAvatar}
            footerGeneration
            onActionsReady={setPickerActions}
            onReset={() => {
              setAvatar(null);
              setUploadAttempt(undefined);
            }}
          />
          <Show when={!uploadBusy()}>
            <Errored
              fallback={(error) => (
                <p class="agent-create-dialog__error" role="alert">
                  {formatUiError(error())}
                </p>
              )}
            >
              {uploadOutcome()}
            </Errored>
          </Show>
        </div>
        <openclaw-modal-actions class="agent-create-dialog__actions">
          <button
            type="button"
            class="btn"
            data-action={
              pickerFooter().mode === "generate" && pickerFooter().generated ? "reset" : "cancel"
            }
            onClick={() => {
              if (pickerFooter().mode === "generate" && pickerFooter().generated) {
                pickerActions()?.reset();
              } else {
                props.onCancel();
              }
            }}
          >
            {pickerFooter().mode === "generate" && pickerFooter().generated
              ? t("common.reset")
              : t("common.cancel")}
          </button>
          <button type="submit" class="btn primary" disabled={primaryDisabled()}>
            {needsGeneration()
              ? pickerBusy()
                ? t("agents.identity.avatarGenerating")
                : t("agents.identity.avatarGenerate")
              : pickerFooter().mode === "generate"
                ? t("common.save")
                : t("common.create")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
