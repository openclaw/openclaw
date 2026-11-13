import { createSignal, lazy, Loading, onSettled, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  PersonalProfileOptions,
  personalProfileChoices,
} from "../../components/solid/personal-profile-options.tsx";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { PersonalEnrollmentState } from "./personal-enrollment-state.ts";

registerEnglishCatalog(registerProfileEnglish);

const PersonalRolePreview = lazy(() => import("./personal-role-preview.tsx"), {
  export: "PersonalRolePreview",
});

/** Shared by Profile, Devices and the post-inference optional setup step. */
type PersonalEnrollmentProps = {
  // The caller owns the form lifetime; reconnects update this same Gateway owner.
  initialGateway: ApplicationGateway;
  basePath: string;
  initialDeviceId?: string;
  onLater?: () => void;
  idManaged?: boolean;
  hidden?: boolean;
  onboarding?: boolean;
};

export function PersonalEnrollment(props: PersonalEnrollmentProps) {
  const { owner, view } = projectCallbackOwner(
    (publish) => new PersonalEnrollmentState(props.initialGateway, publish, props.initialDeviceId),
    (state) => state,
  );
  onSettled(() => {
    const stop = owner.gateway.subscribe(() => owner.sync());
    return () => {
      stop();
      owner.dispose();
    };
  });
  const visible = () => {
    const state = view.read();
    return (
      props.initialDeviceId ||
      state.busy ||
      state.error ||
      state.success ||
      state.expectedProfileId ||
      (state.gateway.snapshot.selfUser !== undefined && !state.personal)
    );
  };
  return (
    <Show when={visible()}>
      <Show
        when={props.onboarding}
        fallback={<PersonalEnrollmentForm {...props} staticOwner={owner} readState={view.read} />}
      >
        <div class="custodian-setup__personal">
          <h3>{t("profilePage.enrollment.onboarding")}</h3>
          <PersonalEnrollmentForm {...props} staticOwner={owner} readState={view.read} />
          <Show when={props.onLater}>
            <button class="btn btn--ghost" type="button" onClick={() => props.onLater?.()}>
              {t("profilePage.enrollment.later")}
            </button>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

function PersonalEnrollmentForm(
  props: PersonalEnrollmentProps & {
    staticOwner: PersonalEnrollmentState;
    readState: () => PersonalEnrollmentState;
  },
) {
  const owner = props.staticOwner;
  const directory = profileDirectory(owner.gateway);
  const people = projectOwner(directory, (source) => source);
  const [expanded, setExpanded] = createSignal(false);
  const state = () => props.readState();
  const snapshot = () => state().gateway.snapshot;
  const attached = () => !props.initialDeviceId && state().personal && !state().expectedProfileId;
  const disconnected = () => snapshot().phase !== "connected";
  const selectedRole = () =>
    personalProfileChoices(people.read().result?.profiles).find(
      (person) => person.id === state().profileId,
    )?.effectiveRole;
  const needsEnrollment = () => !attached() && !state().success && !state().expectedProfileId;
  return (
    <div class="personal-enrollment" hidden={props.hidden}>
      <SettingsSection title={t("profilePage.enrollment.title")}>
        <SettingsRow
          title={t("profilePage.enrollment.description")}
          description={!state().personal ? t("profilePage.enrollment.shared") : undefined}
          stackedOnNarrow
          control={
            needsEnrollment() && !expanded() ? (
              <button class="btn" disabled={!state().canEnroll} onClick={() => setExpanded(true)}>
                {t("profilePage.enrollment.start")}
              </button>
            ) : undefined
          }
        />
        <Show when={needsEnrollment() && !state().canEnroll}>
          <SettingsRow
            title={t(
              disconnected()
                ? "profilePage.enrollment.reconnect"
                : "profilePage.enrollment.restricted",
            )}
          />
        </Show>
        <Show when={state().reconnecting}>
          <div class="settings-row" role="status">
            {t("profilePage.enrollment.reconnecting")}
          </div>
        </Show>
        <Show when={attached() || state().success}>
          <div class="settings-row" role="status">
            {t(
              state().success && !state().expectedProfileId
                ? "profilePage.enrollment.assignmentCommitted"
                : "profilePage.enrollment.success",
            )}
          </div>
        </Show>
        <Show when={expanded() && needsEnrollment()}>
          <form
            class="personal-enrollment__form"
            onSubmit={(event) => {
              event.preventDefault();
              void owner.enroll();
            }}
          >
            <SettingsRow
              title={t("profilePage.enrollment.choose")}
              description={t("profilePage.enrollment.existingHint")}
              stackedOnNarrow
              control={
                <select
                  class="settings-select"
                  aria-label={t("profilePage.enrollment.choose")}
                  value={state().profileId}
                  disabled={state().busy || !state().canEnroll}
                  onChange={(event) => {
                    owner.profileId = event.currentTarget.value;
                    owner.publish();
                  }}
                >
                  <option value="">{t("profilePage.enrollment.newPerson")}</option>
                  <PersonalProfileOptions profiles={people.read().result?.profiles} />
                </select>
              }
            />
            <Show when={state().profileId}>
              <SettingsRow
                title={
                  selectedRole()
                    ? t("profilePage.enrollment.rolePreview", { role: selectedRole() ?? "" })
                    : t("profilePage.enrollment.defaultRolePreview")
                }
              />
            </Show>
            <Show when={people.read().error}>
              <div class="settings-row">
                <InlineAlert
                  tone="danger"
                  action={
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => void directory.load(true)}
                    >
                      {t("common.retry")}
                    </button>
                  }
                >
                  {t("profilePage.enrollment.directoryFailed")}
                </InlineAlert>
              </div>
            </Show>
            <Show when={!state().profileId && state().canEnroll}>
              <Loading fallback={<p class="muted">{t("common.loading")}</p>}>
                <PersonalRolePreview
                  ceiling={props.initialDeviceId ? undefined : snapshot().hello?.auth?.scopes}
                />
              </Loading>
            </Show>
            <Show when={!state().profileId}>
              <SettingsRow
                title={t("profilePage.enrollment.name")}
                stackedOnNarrow
                control={
                  <input
                    class="settings-input"
                    autocomplete="name"
                    maxlength={256}
                    aria-label={t("profilePage.enrollment.name")}
                    value={state().name}
                    disabled={state().busy}
                    onInput={(event) => {
                      owner.name = event.currentTarget.value;
                      owner.publish();
                    }}
                  />
                }
              />
            </Show>
            <Show when={state().error}>
              <div class="settings-row">
                <InlineAlert tone="danger">{state().error}</InlineAlert>
              </div>
            </Show>
            <openclaw-modal-actions class="settings-row">
              <button
                type="button"
                class="btn btn--ghost"
                disabled={state().busy}
                onClick={() => {
                  setExpanded(false);
                  props.onLater?.();
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                class="btn primary"
                disabled={state().busy || !state().canEnroll}
              >
                {t(
                  state().busy ? "profilePage.enrollment.saving" : "profilePage.enrollment.create",
                )}
              </button>
            </openclaw-modal-actions>
          </form>
        </Show>
        <Show when={state().expectedProfileId && state().error}>
          <div class="settings-row">
            <InlineAlert tone="danger">{state().error}</InlineAlert>
          </div>
        </Show>
        <Show when={disconnected() || (state().expectedProfileId && state().error)}>
          <SettingsRow
            title={t("profilePage.enrollment.reconnect")}
            control={
              <button class="btn" onClick={() => owner.gateway.connect()}>
                {t("profilePage.access.reconnect")}
              </button>
            }
          />
        </Show>
        <Show when={props.idManaged}>
          <SettingsRow
            title={t("profilePage.enrollment.idOwner")}
            description={t("profilePage.enrollment.idOwnerDescription")}
            stackedOnNarrow
            control={
              <a
                class="btn"
                href={
                  pathForRoute("plugin", props.basePath) + "?plugin=openclaw-id-access&id=access"
                }
              >
                {t("profilePage.enrollment.openAccess")}
              </a>
            }
          />
        </Show>
      </SettingsSection>
    </div>
  );
}
