import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import "../../components/modal-dialog.tsx";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import {
  buildDefaultRole,
  buildRoleCreate,
  buildRoleDelete,
  isAdminRole,
  isValidRoleName,
  planAdminRole,
  presetDefinition,
  type RoleDefinition,
  type RolePreset,
} from "./role-catalog.ts";
import { RoleAvatar, profileLabel } from "./role-person.tsx";
import type { RoleProfile, RolesState } from "./use-roles.ts";

export type RoleDialog =
  | { kind: "create" }
  | { kind: "duplicate"; role: string }
  | { kind: "assign"; role: string }
  | { kind: "delete"; role: string }
  | { kind: "enable-default"; role: string };

const PRESETS: readonly RolePreset[] = ["guest", "operator", "admin", "blank"];
const PRESET_KEYS: Record<RolePreset, string> = {
  guest: "presetGuest",
  operator: "presetOperator",
  admin: "presetAdmin",
  blank: "presetBlank",
};

function Frame(props: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  /** Shown with a spinner on the submit button while the dialog's writes run. */
  busyLabel?: string;
  submitDisabled: boolean;
  danger?: boolean;
  wide?: boolean;
  children: JSX.Element;
}) {
  return (
    <openclaw-modal-dialog
      label={props.title}
      description={props.description}
      style={{ "--openclaw-modal-width": props.wide ? "600px" : "520px" }}
      onModal-cancel={(event: Event) => {
        if (props.busy) {
          event.preventDefault();
        } else {
          props.onClose();
        }
      }}
    >
      <form
        class="oc-dialog roles-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.submitDisabled && !props.busy) {
            props.onSubmit();
          }
        }}
      >
        <DialogHeader
          title={props.title}
          description={props.description}
          closeDisabled={props.busy}
          onClose={() => props.onClose()}
        />
        <div class="oc-dialog__body roles-dialog__body">{props.children}</div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button type="button" class="btn" disabled={props.busy} onClick={() => props.onClose()}>
            {t("rolesPage.cancel")}
          </button>
          <button
            type="submit"
            class={["btn", props.danger ? "danger" : "primary"]}
            disabled={props.submitDisabled || props.busy}
            aria-busy={props.busy ? "true" : undefined}
          >
            <Show when={props.busy}>
              <span class="btn__spinner" aria-hidden="true" />{" "}
            </Show>
            {props.busy ? (props.busyLabel ?? props.submitLabel) : props.submitLabel}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}

function NameField(props: {
  value: string;
  error: string | null;
  onInput: (value: string) => void;
}) {
  return (
    <label class="field roles-field">
      <span>{t("rolesPage.name")}</span>
      <input
        type="text"
        autocomplete="off"
        spellcheck="false"
        value={props.value}
        aria-invalid={props.error ? "true" : undefined}
        onInput={(event) => props.onInput(event.currentTarget.value.trim())}
      />
      <span
        class={props.error ? "roles-error" : "roles-hint"}
        role={props.error ? "alert" : undefined}
      >
        {props.error ?? t("rolesPage.nameHint")}
      </span>
    </label>
  );
}

function PeoplePicker(props: {
  people: readonly RoleProfile[];
  selected: ReadonlySet<string>;
  disabled: (profile: RoleProfile) => boolean;
  detail: (profile: RoleProfile) => string;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <ul class="roles-picker">
      <For each={props.people}>
        {(profile) => (
          <li>
            <label class="roles-picker__row">
              <Checkbox
                checked={props.selected.has(profile.id) || props.disabled(profile)}
                disabled={props.disabled(profile)}
                onChange={(event) => props.onToggle(profile.id, event.currentTarget.checked)}
              />
              <RoleAvatar profile={profile} />
              <span class="roles-picker__name">{profileLabel(profile)}</span>
              <span class="roles-hint">{props.detail(profile)}</span>
            </label>
          </li>
        )}
      </For>
    </ul>
  );
}

function selection() {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  return {
    selected,
    toggle: (id: string, on: boolean) =>
      setSelected((current) => {
        const next = new Set(current);
        if (on) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      }),
  };
}

function nameError(name: string, taken: (name: string) => boolean): string | null {
  if (!name) {
    return null;
  }
  if (!isValidRoleName(name)) {
    return t("rolesPage.nameInvalid");
  }
  return taken(name) ? t("rolesPage.errors.exists") : null;
}

type DialogProps = {
  roles: RolesState;
  role: string;
  onClose: () => void;
  onOpen: (name: string) => void;
};

function useCreate(props: DialogProps) {
  const taken = (name: string) => props.roles.catalog().roles.some((role) => role.name === name);
  return {
    taken,
    async create(name: string, definition: RoleDefinition, move: readonly RoleProfile[]) {
      const created = await props.roles.patch(
        (base) => buildRoleCreate(base, name, definition),
        "Create role " + name,
        t("rolesPage.saved"),
      );
      if (!created || (move.length && !(await props.roles.assign(move, name)))) {
        return;
      }
      props.onClose();
      props.onOpen(name);
    },
  };
}

function ErrorAlert(props: { roles: RolesState }) {
  return (
    <Show when={props.roles.state().error}>
      {(message) => <InlineAlert tone="danger">{message()}</InlineAlert>}
    </Show>
  );
}

function CreateRoleDialog(props: DialogProps) {
  const flow = useCreate(props);
  const [preset, setPreset] = createSignal<RolePreset>("guest");
  const [name, setName] = createSignal("");
  const problem = createMemo(() => nameError(name(), flow.taken));
  return (
    <Frame
      title={t("rolesPage.createTitle")}
      description={t("rolesPage.createDescription")}
      busy={props.roles.busy()}
      wide
      onClose={props.onClose}
      submitLabel={t("rolesPage.create")}
      submitDisabled={!name() || Boolean(problem())}
      onSubmit={() => void flow.create(name(), presetDefinition(preset()), [])}
    >
      <div class="roles-presets" role="radiogroup" aria-label={t("rolesPage.createTitle")}>
        <For each={PRESETS}>
          {(value) => (
            <label class={["roles-preset", { "roles-preset--selected": preset() === value }]}>
              <input
                type="radio"
                name="role-preset"
                checked={preset() === value}
                onChange={() => setPreset(value)}
              />
              <strong>{t("rolesPage." + PRESET_KEYS[value])}</strong>
              <span>{t("rolesPage." + PRESET_KEYS[value] + "Description")}</span>
            </label>
          )}
        </For>
      </div>
      <NameField value={name()} error={problem()} onInput={setName} />
      <ErrorAlert roles={props.roles} />
    </Frame>
  );
}

function DuplicateRoleDialog(props: DialogProps) {
  const flow = useCreate(props);
  const [name, setName] = createSignal(() => props.role + "-copy");
  const problem = createMemo(() => nameError(name(), flow.taken));
  const definition = () =>
    props.roles.catalog().roles.find((role) => role.name === props.role)?.definition;
  const people = () => props.roles.people().get(props.role) ?? [];
  const move = selection();
  return (
    <Frame
      title={t("rolesPage.duplicateTitle", { role: props.role })}
      description={t("rolesPage.duplicateDescription")}
      busy={props.roles.busy()}
      onClose={props.onClose}
      submitLabel={t("rolesPage.duplicate")}
      submitDisabled={!name() || Boolean(problem()) || !definition()}
      onSubmit={() => {
        const source = definition();
        if (source) {
          void flow.create(
            name(),
            structuredClone(source),
            people().filter((profile) => move.selected().has(profile.id)),
          );
        }
      }}
    >
      <NameField value={name()} error={problem()} onInput={setName} />
      <Show when={people().length}>
        <fieldset class="roles-fieldset">
          <legend>{t("rolesPage.moveToCopy")}</legend>
          <PeoplePicker
            people={people()}
            selected={move.selected()}
            disabled={() => false}
            detail={() => props.role}
            onToggle={move.toggle}
          />
          <p class="roles-hint">{t("rolesPage.moveHint")}</p>
        </fieldset>
      </Show>
      <ErrorAlert roles={props.roles} />
    </Frame>
  );
}

function AssignPeopleDialog(props: DialogProps) {
  const [query, setQuery] = createSignal("");
  const picked = selection();
  const people = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return props.roles
      .profiles()
      .filter(
        (profile) =>
          !needle ||
          profileLabel(profile).toLowerCase().includes(needle) ||
          Boolean(profile.githubIdentity?.login.toLowerCase().includes(needle)),
      );
  });
  const chosen = () =>
    props.roles.profiles().filter((profile) => picked.selected().has(profile.id));
  return (
    <Frame
      title={t("rolesPage.assignTitle", { role: props.role })}
      description={t("rolesPage.assignDescription")}
      busy={props.roles.busy()}
      wide
      onClose={props.onClose}
      submitLabel={
        chosen().length
          ? t("rolesPage.assignCount", { count: String(chosen().length) })
          : t("rolesPage.assign")
      }
      submitDisabled={chosen().length === 0}
      onSubmit={() =>
        void props.roles.assign(chosen(), props.role).then((ok) => {
          if (ok) {
            props.onClose();
          }
        })
      }
    >
      <label class="field roles-field">
        <span class="sr-only">{t("rolesPage.searchPeople")}</span>
        <input
          type="search"
          placeholder={t("rolesPage.searchPeople")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <PeoplePicker
        people={people()}
        selected={picked.selected()}
        disabled={(profile) => profile.effectiveRole === props.role}
        detail={(profile) =>
          profile.effectiveRole === props.role
            ? t("rolesPage.alreadyHasRole", { role: props.role })
            : (profile.effectiveRole ?? "") + " → " + props.role
        }
        onToggle={picked.toggle}
      />
      <ErrorAlert roles={props.roles} />
    </Frame>
  );
}

function DeleteRoleDialog(props: DialogProps) {
  const catalog = () => props.roles.catalog();
  const others = () => catalog().roles.filter((entry) => entry.name !== props.role);
  const initialReplacement = () => {
    const fallback = catalog().defaultRole;
    return fallback && fallback !== props.role ? fallback : (others()[0]?.name ?? "");
  };
  const [replacement, setReplacement] = createSignal(() => initialReplacement());
  // Saved assignments count even before roles turn on, when they are not yet anyone's effective role.
  const people = () =>
    props.roles
      .profiles()
      .filter((profile) => profile.effectiveRole === props.role || profile.role === props.role);
  const mappings = () =>
    Object.values(catalog().githubMappings).filter((value) => value === props.role).length;
  const self = () => props.roles.selfProfileId();
  const selfAssigned = () =>
    people().some((profile) => profile.role === props.role && profile.id === self());
  const replacementIsAdmin = () => {
    const entry = catalog().roles.find((role) => role.name === replacement());
    return entry ? isAdminRole(entry.definition) : false;
  };
  // Moving yourself to a role without administrator access would end your right to finish.
  const blockedBySelf = () => selfAssigned() && !replacementIsAdmin();
  const remove = async () => {
    const role = props.role;
    const target = replacement();
    const finish = async () => {
      if (
        await props.roles.patch(
          (base) => buildRoleDelete(base, role, target),
          "Delete role " + role,
          t("rolesPage.saved"),
        )
      ) {
        props.onClose();
        props.onOpen("");
      }
    };
    // Mapped people follow their repointed GitHub mapping; only explicit assignments move here.
    const assigned = people().filter((profile) => profile.role === role);
    const movers = assigned.filter((profile) => profile.id !== self());
    const mine = assigned.filter((profile) => profile.id === self());
    if (movers.length && !(await props.roles.assign(movers, target))) {
      return;
    }
    // Your own move closes this connection, so it goes last and deletion resumes on reconnect.
    if (mine.length) {
      props.roles.resumeAfterReconnect(() => void finish());
      if (!(await props.roles.assign(mine, target))) {
        if (props.roles.state().error) {
          props.roles.cancelResume();
        }
        return;
      }
      props.roles.cancelResume();
    }
    await finish();
  };
  return (
    <Frame
      title={t("rolesPage.deleteTitle", { role: props.role })}
      description={
        people().length
          ? t("rolesPage.deletePeople", { count: String(people().length) })
          : t("rolesPage.deleteNobody")
      }
      busy={props.roles.busy()}
      danger
      onClose={props.onClose}
      submitLabel={people().length ? t("rolesPage.deleteConfirm") : t("rolesPage.delete")}
      // Reassignment needs the current roster; an unloaded one would look like nobody has the role.
      submitDisabled={!replacement() || !props.roles.peopleLoaded() || blockedBySelf()}
      onSubmit={() => void remove()}
    >
      <label class="field roles-field">
        <span>{t("rolesPage.deleteMoveTo")}</span>
        <SettingsSelect
          value={replacement()}
          options={others().map((entry) => ({ value: entry.name, label: entry.name }))}
          onChange={(event) => setReplacement(event.currentTarget.value)}
        />
      </label>
      <Show when={blockedBySelf()}>
        <InlineAlert tone="warning" compact role="note">
          {t("rolesPage.deleteSelfNeedsAdmin")}
        </InlineAlert>
      </Show>
      <Show when={mappings()}>
        <InlineAlert tone="warning" compact role="note">
          {t("rolesPage.deleteMappings", { count: String(mappings()) })}
        </InlineAlert>
      </Show>
      <ErrorAlert roles={props.roles} />
    </Frame>
  );
}

/**
 * Turning on a default role puts everyone without an assignment under it, including the
 * person doing it. Administrators are chosen first, with the signed-in person kept, so the
 * default never takes away the access needed to undo it.
 */
function EnableDefaultDialog(props: DialogProps) {
  const plan = createMemo(() => planAdminRole(props.roles.catalog()));
  const self = () => props.roles.selfProfileId();
  const isAdmin = (profile: RoleProfile) => profile.effectiveRole === plan()?.name;
  const picked = selection();
  const chosen = () =>
    props.roles
      .profiles()
      .filter(
        (profile) =>
          !isAdmin(profile) && (profile.id === self() || picked.selected().has(profile.id)),
      );
  const save = async () => {
    const admin = plan();
    const role = props.role;
    if (!admin) {
      return;
    }
    if (
      admin.create &&
      !(await props.roles.patch(
        (base) => buildRoleCreate(base, admin.name, presetDefinition("admin")),
        "Create role " + admin.name,
        t("rolesPage.saved"),
      ))
    ) {
      return;
    }
    const finish = async () => {
      if (
        await props.roles.patch(
          (base) => buildDefaultRole(base, role),
          "Set default role " + role,
          t("rolesPage.saved"),
        )
      ) {
        props.onClose();
      }
    };
    // Assigning yourself closes your own connection, so you go last and the default is set
    // once you reconnect as an administrator.
    const others = chosen().filter((profile) => profile.id !== self());
    const mine = chosen().filter((profile) => profile.id === self());
    if (others.length && !(await props.roles.assign(others, admin.name))) {
      return;
    }
    if (mine.length) {
      props.roles.resumeAfterReconnect(() => void finish());
      if (!(await props.roles.assign(mine, admin.name))) {
        if (props.roles.state().error) {
          props.roles.cancelResume();
        }
        return;
      }
      props.roles.cancelResume();
    }
    await finish();
  };
  return (
    <Frame
      title={t("rolesPage.enableDefaultTitle")}
      description={t("rolesPage.enableDefaultDescription", { role: props.role })}
      busy={props.roles.busy()}
      wide
      onClose={props.onClose}
      submitLabel={t("rolesPage.enableDefaultSave")}
      busyLabel={t("rolesPage.enableDefaultSaving")}
      submitDisabled={!plan() || !props.roles.peopleLoaded()}
      onSubmit={() => void save()}
    >
      <Show
        when={plan()}
        fallback={
          <InlineAlert tone="danger" role="note">
            {t("rolesPage.enableDefaultNoAdminRole")}
          </InlineAlert>
        }
      >
        {(admin) => (
          <fieldset class="roles-fieldset">
            <legend>
              {admin().create
                ? t("rolesPage.enableDefaultCreateAdmin", { role: admin().name })
                : t("rolesPage.enableDefaultAdmins", { role: admin().name })}
            </legend>
            <PeoplePicker
              people={props.roles.profiles()}
              selected={picked.selected()}
              disabled={(profile) => isAdmin(profile) || profile.id === self()}
              detail={(profile) =>
                isAdmin(profile)
                  ? t("rolesPage.alreadyHasRole", { role: admin().name })
                  : profile.id === self()
                    ? t("rolesPage.enableDefaultYou", { role: admin().name })
                    : (profile.effectiveRole ?? props.role) + " → " + admin().name
              }
              onToggle={picked.toggle}
            />
          </fieldset>
        )}
      </Show>
      <ErrorAlert roles={props.roles} />
    </Frame>
  );
}

export function RoleDialogs(props: {
  roles: RolesState;
  dialog: RoleDialog;
  onClose: () => void;
  onOpen: (name: string) => void;
}) {
  const role = () => ("role" in props.dialog ? props.dialog.role : "");
  return (
    <Switch>
      <Match when={props.dialog.kind === "create"}>
        <CreateRoleDialog
          roles={props.roles}
          role=""
          onClose={props.onClose}
          onOpen={props.onOpen}
        />
      </Match>
      <Match when={props.dialog.kind === "duplicate"}>
        <DuplicateRoleDialog
          roles={props.roles}
          role={role()}
          onClose={props.onClose}
          onOpen={props.onOpen}
        />
      </Match>
      <Match when={props.dialog.kind === "assign"}>
        <AssignPeopleDialog
          roles={props.roles}
          role={role()}
          onClose={props.onClose}
          onOpen={props.onOpen}
        />
      </Match>
      <Match when={props.dialog.kind === "enable-default"}>
        <EnableDefaultDialog
          roles={props.roles}
          role={role()}
          onClose={props.onClose}
          onOpen={props.onOpen}
        />
      </Match>
      <Match when={props.dialog.kind === "delete"}>
        <DeleteRoleDialog
          roles={props.roles}
          role={role()}
          onClose={props.onClose}
          onOpen={props.onOpen}
        />
      </Match>
    </Switch>
  );
}
