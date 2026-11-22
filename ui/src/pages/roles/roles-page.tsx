import { createMemo, createSignal, Match, onSettled, Show, Switch } from "solid-js";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  RetryAction,
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsPageHeader,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerRolesEnglish } from "../../i18n/locales/en-roles.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { RoleDialogs, type RoleDialog } from "./role-dialogs.tsx";
import { RoleEditor } from "./role-editor.tsx";
import { RoleList } from "./role-list.tsx";
import { useRoles } from "./use-roles.ts";
import "../../styles/roles.css";

registerEnglishCatalog(registerRolesEnglish);

/** Settings → Team → Roles: administrators manage gateway.roles and who has each role. */
export function RolesPage() {
  const context = useApplication();
  const roles = useRoles();
  const [search, setSearch] = createSignal(context.router.getState().location.search, {
    ownedWrite: true,
  });
  onSettled(() =>
    context.router.subscribe(() => setSearch(context.router.getState().location.search)),
  );
  const selected = createMemo(() => new URLSearchParams(search()).get("role") ?? "");
  const [dialog, setDialog] = createSignal<RoleDialog | null>(null);
  const open = (name: string) => {
    roles.clearMessages();
    context.navigate("roles", {
      search: name ? "?" + new URLSearchParams({ role: name }).toString() : "",
    });
  };
  const definition = () =>
    roles.catalog().roles.find((role) => role.name === selected())?.definition;
  return (
    <SettingsPage>
      <Show when={!selected()}>
        <SettingsPageHeader
          title={t("rolesPage.title")}
          subtitle={t("rolesPage.configPath", { path: "gateway.roles" })}
        />
      </Show>
      <SettingsWorkspace>
        <Switch>
          <Match when={!roles.canAdmin()}>
            <SettingsEmpty message={t("rolesPage.adminOnly")} />
          </Match>
          <Match when={roles.loading()}>
            <SettingsLoadingSkeleton label={t("rolesPage.loading")} rows={4} />
          </Match>
          <Match when={roles.loadError()}>
            {(error) => (
              <InlineAlert
                tone="danger"
                action={<RetryAction onRetry={() => void roles.reload()} />}
              >
                {t("rolesPage.loadFailed")} {error()}
              </InlineAlert>
            )}
          </Match>
          <Match when={selected() ? definition() : undefined}>
            {(current) => (
              <RoleEditor
                roles={roles}
                name={selected()}
                definition={current()}
                onBack={() => open("")}
                onDuplicate={() => setDialog({ kind: "duplicate", role: selected() })}
                onAssign={() => setDialog({ kind: "assign", role: selected() })}
                onDelete={() => setDialog({ kind: "delete", role: selected() })}
              />
            )}
          </Match>
          <Match when={true}>
            <Show when={roles.state().notice}>
              {(notice) => <InlineAlert tone="success">{notice()}</InlineAlert>}
            </Show>
            <Show when={selected()}>
              <InlineAlert tone="warning">{t("rolesPage.errors.missing")}</InlineAlert>
            </Show>
            <RoleList roles={roles} onOpen={open} onCreate={() => setDialog({ kind: "create" })} />
          </Match>
        </Switch>
      </SettingsWorkspace>
      <Show when={dialog()}>
        {(current) => (
          <RoleDialogs
            roles={roles}
            dialog={current()}
            onClose={() => {
              roles.clearMessages();
              setDialog(null);
            }}
            onOpen={open}
          />
        )}
      </Show>
    </SettingsPage>
  );
}
