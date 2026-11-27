import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import {
  builtinDeveloperProfiles,
  type DeveloperDiagnostic,
  type DeveloperProfile,
} from "../../../../../src/shared/dictation-developer.ts";
import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ComposerDeveloperSyntax } from "../composer-developer-syntax.ts";
import { captureDeveloperDictationTarget } from "../composer-developer-target.ts";
import type { ChatComposerState } from "./chat-composer-types.ts";

function profileLabel(profile: DeveloperProfile) {
  if (!builtinDeveloperProfiles.includes(profile)) {
    return profile.name;
  }
  switch (profile.language) {
    case "plain-code":
      return t("chat.dictation.developer.plainCodeProfile");
    case "json":
      return t("chat.dictation.developer.jsonProfile");
    case "typescript":
      return t("chat.dictation.developer.typescriptProfile");
    case "python":
      return t("chat.dictation.developer.pythonProfile");
  }
  return profile.name;
}

function diagnosticLabel(code: DeveloperDiagnostic["code"]) {
  switch (code) {
    case "incomplete":
      return t("chat.dictation.developer.incompleteDiagnostic");
    case "ambiguous":
      return t("chat.dictation.developer.ambiguousDiagnostic");
    case "syntax":
      return t("chat.dictation.developer.syntaxDiagnostic");
    case "unsupported":
      return t("chat.dictation.developer.unsupportedDiagnostic");
    case "invalid":
      return t("chat.dictation.developer.invalidDiagnostic");
    case "limit":
      return t("chat.dictation.developer.limitDiagnostic");
  }
  return t("chat.dictation.developer.invalidDiagnostic");
}

function alternativeLabel(label: string) {
  switch (label) {
    case "Hyphen-minus (-)":
      return t("chat.dictation.developer.hyphenMinus");
    case "Minus sign (−)":
      return t("chat.dictation.developer.minusSign");
    case "Em dash (—)":
      return t("chat.dictation.developer.emDash");
    default:
      return label; // Authored profile labels are data, not application copy.
  }
}

const exactStyle = { "font-family": "var(--mono)", "font-variant-ligatures": "none" };

function SyntaxPreview(props: {
  text: string;
  label: string;
  rows: number;
  direction: "auto" | "ltr";
}) {
  return (
    <Show
      when={props.text.includes("\r")}
      fallback={
        <label class="field">
          {props.label}
          <textarea
            readonly
            rows={props.rows}
            dir={props.direction}
            value={props.text}
            style={{ ...exactStyle, "min-height": "0", "min-width": "0" }}
          />
        </label>
      }
    >
      <div>
        <p>{props.label}</p>
        <pre
          aria-label={props.label}
          dir={props.direction}
          style={{
            ...exactStyle,
            "white-space": "pre-wrap",
            "overflow-wrap": "anywhere",
            "unicode-bidi": "isolate",
          }}
        >
          {props.text}
        </pre>
      </div>
    </Show>
  );
}

type DeveloperSyntaxPanelProps = { readOwner: () => ComposerDeveloperSyntax | null };

export function DeveloperSyntaxContent(
  props: DeveloperSyntaxPanelProps & { state: ChatComposerState; settings?: true },
) {
  onSettled(() => {
    const state = props.state;
    if (!state.developerSyntax) {
      // The lazy presenter must be mounted before it can install the pane owner.
      state.developerSyntax = new ComposerDeveloperSyntax({
        readSettings: () => loadSettings().developerDictation,
        saveSettings: (value) => patchSettings({ developerDictation: value }),
        captureTarget: () => {
          const composer = state.developerSyntaxHost?.readProps();
          return composer ? captureDeveloperDictationTarget(composer, state) : undefined;
        },
        cancelCapture: () => state.dictation?.cancel(),
        copy: (text) => navigator.clipboard.writeText(text),
      });
      state.setDeveloperSyntax(state.developerSyntax);
    }
  });
  return (
    <Show when={props.readOwner()}>
      <Show when={props.settings} fallback={<DeveloperSyntaxReview readOwner={props.readOwner} />}>
        <DeveloperSyntaxSettings readOwner={props.readOwner} />
      </Show>
    </Show>
  );
}

function DeveloperSyntaxSettings(props: DeveloperSyntaxPanelProps) {
  const [importText, setImportText] = createSignal("");
  const [exportText, setExportText] = createSignal("");
  const owner = () => props.readOwner();
  return (
    <>
      <fieldset
        style={{ display: "grid", gap: "8px", "min-width": "0" }}
        disabled={owner()?.invalidSettings}
      >
        <label class="field checkbox">
          <input
            type="checkbox"
            checked={owner()?.settings.enabled ?? false}
            onChange={(event) => owner()?.configure({ enabled: event.currentTarget.checked })}
          />
          {t("chat.dictation.developer.enable")}
        </label>
        <label class="field">
          {t("chat.dictation.developer.mode")}
          <select
            value={owner()?.settings.mode ?? "prose"}
            onChange={(event) => {
              const mode = event.currentTarget.value;
              if (mode === "prose" || mode === "literal" || mode === "developer") {
                owner()?.configure({ mode });
              }
            }}
          >
            <option value="prose">{t("chat.dictation.developer.prose")}</option>
            <option value="literal">{t("chat.dictation.developer.literal")}</option>
            <option value="developer">{t("chat.dictation.developer.developer")}</option>
          </select>
        </label>
        <label class="field">
          {t("chat.dictation.developer.locale")}
          <select
            value={owner()?.settings.locale ?? ""}
            onChange={(event) => owner()?.configure({ locale: event.currentTarget.value })}
          >
            <option value="">{t("chat.dictation.developer.chooseLocale")}</option>
            <Show when={owner()?.settings.locale && owner()?.settings.locale !== "en-US"}>
              <option value={owner()?.settings.locale}>{owner()?.settings.locale}</option>
            </Show>
            <option value="en-US">{t("chat.dictation.developer.english")}</option>
          </select>
        </label>
        <label class="field">
          {t("chat.dictation.developer.profile")}
          <select
            value={owner()?.settings.profileId ?? "en-us-plain-code"}
            onChange={(event) => owner()?.configure({ profileId: event.currentTarget.value })}
          >
            <For each={owner()?.profiles ?? []}>
              {(profile) => <option value={profile.id}>{profileLabel(profile)}</option>}
            </For>
          </select>
        </label>
        <p>{t("chat.dictation.developer.grammar")}</p>
        <label class="field">
          {t("chat.dictation.developer.importLabel")}
          <textarea
            rows="3"
            value={importText()}
            maxlength="65536"
            dir="ltr"
            onInput={(event) => setImportText(event.currentTarget.value)}
          />
        </label>
        <button
          class="btn btn--sm"
          type="button"
          onClick={() => {
            if (owner()?.importProfile(importText())) {
              setImportText("");
            }
          }}
        >
          {t("chat.dictation.developer.import")}
        </button>
      </fieldset>
      <button
        class="btn btn--sm"
        type="button"
        onClick={() => setExportText(owner()?.exportProfile() ?? "")}
      >
        {t("chat.dictation.developer.export")}
      </button>
      <Show when={exportText()}>
        <label class="field">
          {t("chat.dictation.developer.exportLabel")}
          <textarea readonly rows="5" dir="ltr" value={exportText()} />
        </label>
      </Show>
      <Show when={owner()?.invalidSettings}>
        <p role="status">{t("chat.dictation.developer.invalidSettings")}</p>
        <button class="btn btn--sm" type="button" onClick={() => owner()?.useProseFallback()}>
          {t("chat.dictation.developer.useProseFallback")}
        </button>
      </Show>
    </>
  );
}

function DeveloperSyntaxReview(props: DeveloperSyntaxPanelProps) {
  const [inspect, setInspect] = createSignal(false);
  const owner = () => props.readOwner();
  const review = () => owner()?.review;
  const characters = createMemo(() => {
    const text = review()?.text ?? "";
    if (!inspect()) {
      return "";
    }
    return Array.from(text)
      .slice(0, 4096)
      .map((character) => {
        const name =
          character === "\r"
            ? t("chat.dictation.developer.carriageReturn")
            : character === "\n"
              ? t("chat.dictation.developer.newline")
              : character === "\t"
                ? t("chat.dictation.developer.tab")
                : character === " "
                  ? t("chat.dictation.developer.space")
                  : character;
        return `${name} (U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`;
      })
      .join(" · ");
  });
  return (
    <>
      <Show when={review()}>
        <section
          aria-label={t("chat.dictation.developer.review")}
          class="developer-syntax__review"
          style={{
            display: "grid",
            gap: "8px",
            "padding-block": "10px",
            "border-top": "1px solid var(--border)",
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              owner()?.cancel();
            }
          }}
        >
          <h3>{t("chat.dictation.developer.review")}</h3>
          <SyntaxPreview
            label={t("chat.dictation.developer.raw")}
            text={review()?.raw ?? ""}
            rows={2}
            direction="auto"
          />
          <Show
            when={review()?.text !== null}
            fallback={<p role="status">{t("chat.dictation.developer.unresolved")}</p>}
          >
            <SyntaxPreview
              label={t("chat.dictation.developer.candidate")}
              text={review()?.text ?? ""}
              rows={4}
              direction="ltr"
            />
          </Show>
          <For each={review()?.plan?.diagnostics ?? []}>
            {(diagnostic) => (
              <div role={diagnostic.severity === "blocking" ? "alert" : "status"}>
                <p>{diagnosticLabel(diagnostic.code)}</p>
                <code
                  dir="ltr"
                  style={{
                    "overflow-wrap": "anywhere",
                    "white-space": "pre-wrap",
                    "unicode-bidi": "isolate",
                  }}
                >
                  {review()?.raw.slice(diagnostic.start, diagnostic.end)}
                </code>
                <Show when={diagnostic.alternatives}>
                  <fieldset class="row" style={{ "flex-wrap": "wrap" }}>
                    <legend>{t("chat.dictation.developer.alternatives")}</legend>
                    <For each={diagnostic.alternatives}>
                      {(alternative) => (
                        <button
                          class="btn btn--sm"
                          type="button"
                          onClick={() => owner()?.choose(diagnostic.id, alternative.text)}
                        >
                          {alternativeLabel(alternative.label)}
                        </button>
                      )}
                    </For>
                  </fieldset>
                </Show>
              </div>
            )}
          </For>
          <button class="btn btn--sm" type="button" onClick={() => owner()?.useOriginal()}>
            {t("chat.dictation.developer.useOriginal")}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            disabled={!review()?.plan?.edits.length}
            onClick={() => owner()?.undoLast()}
          >
            {t("chat.dictation.developer.undoLast")}
          </button>
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={inspect()}
              onChange={(event) => setInspect(event.currentTarget.checked)}
            />
            {t("chat.dictation.developer.inspect")}
          </label>
          <Show when={inspect()}>
            <p
              dir="ltr"
              style={{ "unicode-bidi": "isolate" }}
              aria-label={t("chat.dictation.developer.characters")}
            >
              {characters()}
            </p>
            <Show when={Array.from(review()?.text ?? "").length > 4096}>
              <p>{t("chat.dictation.developer.characterLimit")}</p>
            </Show>
          </Show>
          <p>{t("chat.dictation.developer.copyOnly")}</p>
          <Show when={owner()?.canCopy && !owner()?.canAccept}>
            <p role="status">{t("chat.dictation.developer.copyRequired")}</p>
          </Show>
          <div
            class="developer-syntax__actions row"
            style={{ "flex-wrap": "wrap", "justify-content": "flex-end" }}
          >
            <button class="btn btn--sm" type="button" onClick={() => owner()?.cancel()}>
              {t("chat.dictation.developer.cancel")}
            </button>
            <button
              class="btn btn--sm"
              type="button"
              disabled={!owner()?.canCopy}
              onClick={() => void owner()?.copy()}
            >
              {t("chat.dictation.developer.copy")}
            </button>
            <button
              class="btn btn--sm"
              type="button"
              disabled={!owner()?.canAccept}
              onClick={() => owner()?.accept()}
            >
              {t("chat.dictation.developer.insert")}
            </button>
          </div>
        </section>
      </Show>
      <Show when={owner()?.notice}>
        <p role="status">{owner()?.notice}</p>
      </Show>
    </>
  );
}
