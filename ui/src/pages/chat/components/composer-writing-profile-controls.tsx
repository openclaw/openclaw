import { createMemo, createSignal, For, Show } from "solid-js";
import type { WritingProfileSnapshot } from "../../../../../src/shared/dictation-writing-profiles.js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { registerDictationWritingProfilesEnglish } from "../../../i18n/locales/en-dictation-writing-profiles.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import "./composer-writing-profile-controls.css";

registerDictationWritingProfilesEnglish();
const copy = "talkPage.writingProfiles.composer.";

function ProfileInspection(props: { snapshot: WritingProfileSnapshot; label: string }) {
  return (
    <section class="composer-writing-profiles__inspection" aria-label={props.label}>
      <h3>{props.label}</h3>
      <dl>
        <dt>{t(copy + "selectLabel")}</dt>
        <dd>{props.snapshot.profileLabel ?? t(copy + "noProfile")}</dd>
        <dt>{t(copy + "status")}</dt>
        <dd>{t(copy + "selectionStatuses." + props.snapshot.status)}</dd>
        <dt>{t(copy + "reason")}</dt>
        <dd>{t(copy + "reasons." + props.snapshot.reason)}</dd>
        <Show when={props.snapshot.profileRevision}>
          <dt>{t(copy + "revision")}</dt>
          <dd>{props.snapshot.profileRevision}</dd>
        </Show>
      </dl>
      <Show when={props.snapshot.unavailable.length > 0}>
        <p>{t(copy + "unavailable")}</p>
      </Show>
      <Show when={props.snapshot.advisoryRegister !== "unchanged"}>
        <p>{t(copy + "advisory")}</p>
      </Show>
    </section>
  );
}

export function ComposerWritingProfileControls(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  const context = useOptionalApplication();
  const profiles = () => props.readDictation()?.writingProfiles;
  const selection = createMemo(() => profiles()?.selection);
  const [previewBlocked, setPreviewBlocked] = createSignal(false);
  return (
    <details class="composer-writing-profiles">
      <summary>
        {t(copy + "selectLabel")}: {selection()?.profileLabel ?? t(copy + "noProfile")}
      </summary>
      <div class="composer-writing-profiles__body">
        <p role="status" aria-live="polite">
          {t(copy + "loadStatuses." + (profiles()?.loadStatus ?? "idle"))}
        </p>
        <p>{t(copy + "externalUnsupported")}</p>
        <label>
          <span>{t(copy + "selectLabel")}</span>
          <select
            class="settings-select"
            value={
              profiles()?.disabled
                ? "disabled"
                : profiles()?.overrideId
                  ? `profile:${profiles()?.overrideId}`
                  : ""
            }
            disabled={profiles()?.loadStatus !== "ready" || !profiles()?.catalog.enabled}
            onChange={(event) => {
              setPreviewBlocked(false);
              if (event.currentTarget.value === "disabled") {
                profiles()?.disable();
              } else {
                profiles()?.select(
                  event.currentTarget.value.startsWith("profile:")
                    ? event.currentTarget.value.slice(8)
                    : null,
                );
              }
            }}
          >
            <option value="">{t(copy + "automatic")}</option>
            <option value="disabled">{t(copy + "baseline")}</option>
            <For
              each={profiles()?.catalog.profiles.filter((profile) => profile.enabled)}
              keyed={(profile) => profile.id}
            >
              {(profile) => <option value={`profile:${profile().id}`}>{profile().label}</option>}
            </For>
          </select>
        </label>
        <div class="composer-writing-profiles__actions">
          <button
            class="btn btn--sm"
            type="button"
            disabled={profiles()?.disabled}
            onClick={() => profiles()?.disable()}
          >
            {t(copy + "disable")}
          </button>
          <a href={`${pathForRoute("talk", context?.basePath ?? "")}#dictation-writing-profiles`}>
            {t(copy + "settings")}
          </a>
        </div>
        <Show when={selection()}>
          {(snapshot) => (
            <ProfileInspection snapshot={snapshot()} label={t(copy + "nextRecording")} />
          )}
        </Show>
        <Show when={profiles()?.lastSnapshot}>
          {(snapshot) => (
            <ProfileInspection snapshot={snapshot()} label={t(copy + "capturedRecording")} />
          )}
        </Show>
        <Show when={profiles()?.activeSnapshot}>
          {(snapshot) => (
            <ProfileInspection snapshot={snapshot()} label={t(copy + "activeRecording")} />
          )}
        </Show>
        <details>
          <summary>{t(copy + "diagnostics")}</summary>
          <p>{t(copy + "diagnosticsHelp")}</p>
          <pre>{JSON.stringify(profiles()?.diagnostics, null, 2)}</pre>
        </details>
        <p role="status" aria-live="polite">
          {t(copy + "outcomes." + (profiles()?.outcome ?? "none"))}
        </p>
        <Show when={profiles()?.original !== null && profiles()?.original !== undefined}>
          <details>
            <summary>{t(copy + "recover")}</summary>
            <label>
              <span>{t(copy + "original")}</span>
              <textarea rows={4} readonly value={profiles()?.original ?? ""} />
            </label>
            <button
              class="btn btn--sm"
              type="button"
              disabled={props.readDictation()?.active || props.readDictation()?.transcribing}
              onClick={() => setPreviewBlocked(!profiles()?.reprocess())}
            >
              {t(copy + "reprocess")}
            </button>
            <Show when={profiles()?.outcome === "preview"}>
              <p role="status">{t(copy + "preview")}</p>
            </Show>
            <Show when={previewBlocked()}>
              <p role="status">{t(copy + "previewUnavailable")}</p>
            </Show>
          </details>
        </Show>
      </div>
    </details>
  );
}
