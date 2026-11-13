import { Show } from "solid-js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../../../../src/shared/device-bootstrap-profile.js";
import { userProfileDisplayName } from "../../../../src/shared/user-profile-display-name.js";
import { PersonalProfileOptions } from "../../components/solid/personal-profile-options.tsx";
import type {
  DevicePairSetupAccess,
  DevicePairSetupPerson,
  DevicePairSetupPersonInput,
} from "../../lib/device-pair-setup.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { PersonalRolePreview } from "../profile/personal-role-preview.tsx";

/** A draft only. The setup owner admits the choice and owns its idempotent enrollment ID. */
export function PairingPersonChoice(props: {
  editable: boolean;
  access: DevicePairSetupAccess;
  input: DevicePairSetupPersonInput;
  person?: DevicePairSetupPerson;
  onChange: (input: DevicePairSetupPersonInput) => void;
}) {
  const optionalApplication = useOptionalApplication();
  return (
    <Show when={optionalApplication} keyed>
      {(application) => {
        const gateway = projectGateway(application.gateway);
        const directory = profileDirectory(application.gateway);
        const people = projectOwner(directory, (owner) => owner);
        const canChoose = () =>
          canCallGatewayMethod(gateway.read().snapshot, "device.pair.setupCode", "operator.admin", {
            requireAdvertisement: false,
          });
        const value = () =>
          props.input ? ("profileId" in props.input ? props.input.profileId : "new") : "";
        const profile = () => {
          const input = props.editable ? props.input : props.person;
          return input && "profileId" in input ? directory.get(input.profileId) : undefined;
        };
        const label = () => {
          const person = props.person;
          const existing = profile();
          return existing
            ? userProfileDisplayName(
                existing.id,
                existing.displayName,
                existing.githubIdentity?.login,
              )
            : person && "enrollmentId" in person
              ? person.name || t("devices.pairing.newPerson")
              : t("devices.pairing.unboundPerson");
        };
        return (
          <div class="device-pair-setup__person">
            <Show
              when={props.editable && canChoose()}
              fallback={
                props.person ? (
                  <p>
                    {t("devices.pairing.representedPerson")}: <strong>{label()}</strong>
                  </p>
                ) : undefined
              }
            >
              <label class="field">
                <span>{t("devices.pairing.representedPerson")}</span>
                <select
                  class="settings-select"
                  value={value()}
                  onChange={(event) => {
                    const selected = event.currentTarget.value;
                    props.onChange(
                      selected === "new" ? { name: "" } : selected ? { profileId: selected } : null,
                    );
                  }}
                >
                  <option value="">{t("devices.pairing.unboundPerson")}</option>
                  <option value="new">{t("devices.pairing.newPerson")}</option>
                  <PersonalProfileOptions profiles={people.read().result?.profiles} />
                </select>
              </label>
              <Show when={props.input && "name" in props.input}>
                <label class="field">
                  <span>{t("devices.pairing.personName")}</span>
                  <input
                    class="settings-input"
                    autocomplete="name"
                    maxlength={120}
                    value={props.input && "name" in props.input ? props.input.name : ""}
                    onInput={(event) => props.onChange({ name: event.currentTarget.value })}
                  />
                </label>
              </Show>
              <Show when={people.read().error}>
                <p role="alert">
                  {t("devices.pairing.peopleUnavailable")}{" "}
                  <button
                    type="button"
                    class="btn btn--sm"
                    onClick={() => void directory.load(true)}
                  >
                    {t("common.retry")}
                  </button>
                </p>
              </Show>
              <Show when={props.input && "name" in props.input}>
                <p class="muted">{t("devices.pairing.localPersonHint")}</p>
                <PersonalRolePreview
                  ceiling={
                    props.access === "full"
                      ? FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes
                      : PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes
                  }
                />
              </Show>
              <p class="muted">{t("devices.pairing.personHint")}</p>
            </Show>
            <Show when={profile()}>
              {(person) => (
                <p class="muted">
                  {t("devices.pairing.personRole", {
                    role: person().effectiveRole ?? person().role ?? t("common.unknown"),
                  })}
                </p>
              )}
            </Show>
            <Show when={props.person}>
              <p class="muted">{t("devices.pairing.personAdmission")}</p>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
