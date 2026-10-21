import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { AgentsAvatarGenerateResult } from "../../../../packages/gateway-protocol/src/index.js";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import {
  LOBSTER_PALETTE_WEIGHTS,
  LOBSTER_PET_PALETTES,
} from "../../components/lobster-pet-palettes.ts";
import { AgentIdentityAvatar } from "../../components/solid/identity-avatar.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  imageToAvatarDataUrl,
  svgToAvatarDataUrl,
  type AvatarDataUrlResult,
} from "./avatar-image.ts";
import "./avatar-picker.css";

registerEnglishCatalog(registerSettingsEnglish);

export type GeneratedAvatar = AgentsAvatarGenerateResult;

type Candidate = { name: string; description: string; dataUrl: string };
type Mode = "bot" | "generate" | "upload";
type Preparation = { paletteId: string } | { prompt: string };

export type AvatarPickerProps = {
  agentId: string;
  avatar: string | null;
  disabled: boolean;
  onSelect: (dataUrl: string) => void;
  onUpload: (file: File) => void;
  onGenerate: (prompt: string) => Promise<GeneratedAvatar>;
};

/** Draft-only chooser. The identity editor owns persistence and agent scope. */
export function AvatarPicker(props: AvatarPickerProps) {
  const [mode, setMode] = createSignal<Mode>("bot", { equals: false });
  const [prompt, setPrompt] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [candidate, setCandidate] = createSignal<Candidate | null>(null);
  let operation = 0;
  let fileInput: HTMLInputElement | undefined;
  onSettled(() => () => {
    operation += 1;
  });

  // Each mode selection retires its action state, even when an old transport is still pending.
  const command = createMemo(() => {
    mode();
    const [busy, setBusy] = createOptimistic(false);
    const [completion, setCompletion] = createSignal<Promise<void>>();
    const result = createMemo(() => completion()?.then(() => null));
    const perform = action(async function* (request: Preparation, current: number) {
      setBusy(true);
      if ("paletteId" in request) {
        const { loadLobsterImage } = await import("../../components/lobster-image.ts");
        const image = await loadLobsterImage(request.paletteId);
        if (!image) {
          throw new Error(t("agents.identity.imageUnusable"));
        }
        const dataUrl = requireImage(
          imageToAvatarDataUrl(image, image.naturalWidth, image.naturalHeight),
        );
        yield;
        if (operation === current && !props.disabled) {
          props.onSelect(dataUrl);
          setSelected(request.paletteId);
        }
      } else {
        const generated = await props.onGenerate(request.prompt);
        const dataUrl = requireImage(await svgToAvatarDataUrl(generated.svg));
        yield;
        if (operation === current && !props.disabled) {
          setCandidate({ name: generated.name, description: generated.description, dataUrl });
        }
      }
    });
    return {
      busy,
      result,
      run(request: Preparation) {
        const current = ++operation;
        setCandidate(null);
        const pending = perform(request, current);
        // The result reader mounts after the action settles; handle rejection until then.
        void pending.catch(() => undefined);
        void setCompletion(pending);
      },
    };
  });
  const busy = () => command().busy();

  const requireImage = (result: AvatarDataUrlResult) => {
    if (!result.ok) {
      throw new Error(
        t(
          result.reason === "too-detailed"
            ? "agents.identity.imageTooDetailed"
            : "agents.identity.imageUnusable",
        ),
      );
    }
    return result.dataUrl;
  };
  const changeMode = (next: Mode) => {
    operation += 1;
    setCandidate(null);
    setMode(next);
  };
  const selectPreset = (paletteId: string) => command().run({ paletteId });
  const generate = () => {
    const submitted = prompt().trim();
    if (!submitted || props.disabled) {
      return;
    }
    command().run({ prompt: submitted });
  };

  return (
    <div class="avatar-picker" aria-label={t("agents.identity.avatarPicker")}>
      <div class="avatar-picker__panel">
        <div
          class="avatar-picker__tabs"
          role="group"
          aria-label={t("agents.identity.avatarSource")}
        >
          <For each={["bot", "generate", "upload"] as const}>
            {(tab) => (
              <button
                type="button"
                class="avatar-picker__tab"
                aria-pressed={mode() === tab ? "true" : "false"}
                disabled={props.disabled}
                onClick={() => changeMode(tab)}
              >
                {t(
                  `agents.identity.avatar${tab === "bot" ? "Bot" : tab === "generate" ? "Generate" : "Upload"}`,
                )}
              </button>
            )}
          </For>
        </div>
        <Show when={mode() === "generate"}>
          <div class="avatar-picker__preview">
            <Show
              when={busy() && mode() === "generate"}
              fallback={
                <Show
                  when={candidate()?.dataUrl ?? props.avatar}
                  fallback={
                    <div
                      class="avatar-picker__sprite lobster-pet lobster-pet--palette-crimson"
                      style={lobsterLookStyle(canonicalLobsterLook(LOBSTER_PALETTE_WEIGHTS[0][0]))}
                    >
                      <LobsterSvg
                        look={canonicalLobsterLook(LOBSTER_PALETTE_WEIGHTS[0][0])}
                        standalone
                      />
                    </div>
                  }
                >
                  {(source) => (
                    <AgentIdentityAvatar
                      agent={{
                        id: props.agentId,
                        avatar: source(),
                        name: candidate()?.name ?? t("agents.identity.avatarPreview"),
                      }}
                    />
                  )}
                </Show>
              }
            >
              <div
                class="avatar-picker__ghost avatar-picker__sprite lobster-pet"
                aria-hidden="true"
              >
                <LobsterSvg look={canonicalLobsterLook(LOBSTER_PALETTE_WEIGHTS[0][0])} standalone />
              </div>
            </Show>
          </div>
        </Show>
        <Show when={mode() === "bot"}>
          <div class="avatar-picker__grid" aria-label={t("agents.identity.avatarPresets")}>
            <For each={LOBSTER_PET_PALETTES}>
              {(palette) => (
                <button
                  type="button"
                  class="avatar-picker__preset"
                  aria-label={lobsterPaletteName(palette.id)}
                  title={lobsterPaletteName(palette.id)}
                  aria-pressed={selected() === palette.id ? "true" : "false"}
                  disabled={props.disabled || busy()}
                  onClick={() => selectPreset(palette.id)}
                >
                  <div
                    class={[
                      "avatar-picker__sprite",
                      "lobster-pet",
                      `lobster-pet--palette-${palette.id}`,
                    ]}
                    style={lobsterLookStyle(canonicalLobsterLook(palette))}
                  >
                    <LobsterSvg look={canonicalLobsterLook(palette)} standalone />
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={mode() === "generate"}>
          <div class="avatar-picker__body">
            <label class="field">
              <span class="sr-only">{t("agents.identity.avatarPrompt")}</span>
              <textarea
                rows="4"
                maxlength="8000"
                value={prompt()}
                disabled={props.disabled || busy()}
                placeholder={t("agents.identity.avatarPrompt")}
                onInput={(event) => setPrompt(event.currentTarget.value)}
              />
            </label>
            <Show when={candidate()}>
              {(preview) => (
                <div class="avatar-picker__candidate">
                  <strong>{preview().name}</strong>
                  <p>{preview().description}</p>
                  <div class="avatar-picker__actions">
                    <button type="button" class="btn" onClick={() => setCandidate(null)}>
                      {t("agents.identity.avatarDiscard")}
                    </button>
                    <button
                      type="button"
                      class="btn primary"
                      disabled={props.disabled}
                      onClick={() => {
                        props.onSelect(preview().dataUrl);
                        setSelected(null);
                        setCandidate(null);
                      }}
                    >
                      {t("agents.identity.avatarUse")}
                    </button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={!candidate()}>
              <button
                type="button"
                class="btn avatar-picker__generate"
                disabled={props.disabled || busy() || !prompt().trim()}
                onClick={() => generate()}
              >
                {busy()
                  ? t("agents.identity.avatarGenerating")
                  : t("agents.identity.avatarGenerate")}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={mode() === "upload"}>
          <div class="avatar-picker__body avatar-picker__upload">
            <p>{t("agents.identity.avatarUploadHint")}</p>
            <button
              type="button"
              class="btn"
              disabled={props.disabled}
              onClick={() => fileInput?.click()}
            >
              {t("agents.identity.chooseImage")}
            </button>
            <input
              ref={(input) => {
                fileInput = input;
              }}
              type="file"
              accept="image/*"
              hidden
              disabled={props.disabled}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file && !props.disabled) {
                  operation += 1;
                  setSelected(null);
                  props.onUpload(file);
                }
              }}
            />
          </div>
        </Show>
        <Show when={busy() && mode() === "bot"}>
          <p class="avatar-picker__status" role="status">
            {t("agents.identity.avatarPreparing")}
          </p>
        </Show>
        <Show when={!busy()}>
          <Loading>
            <Errored
              fallback={(error) => (
                <p class="avatar-picker__error" role="alert">
                  {formatUiError(error())}
                </p>
              )}
            >
              {command().result()}
            </Errored>
          </Loading>
        </Show>
      </div>
    </div>
  );
}
