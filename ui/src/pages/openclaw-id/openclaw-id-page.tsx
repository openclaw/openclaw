// Settings → OpenClaw ID: this claw's address and publication, links to Your devices and
// People, Move to new keys and, set apart at the bottom, Reset owner access. Moving keys and
// resetting are offered only on the computer that runs the claw (direct loopback); elsewhere
// the page says so in one line, and the Gateway refuses both remotely whatever the UI shows.
import { createMemo, createSignal, Errored, Loading, Match, Show, Switch } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { clawNameFromHostname } from "../../components/openclaw-id/claw-name.ts";
import { showMoveKeysDialog } from "../../components/openclaw-id/move-keys-dialog.tsx";
import { showOwnerDevicesDialog } from "../../components/openclaw-id/owner-devices-dialog.tsx";
import { showResetOwnerDialog } from "../../components/openclaw-id/reset-owner-dialog.tsx";
import {
  SettingsLoadingSkeleton,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsUnavailable,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { openClawIdAccount } from "../../lib/openclaw-id/account.ts";
import type {
  OpenClawIdPeopleLink,
  OpenClawIdPublication,
  OpenClawIdStatusResult,
} from "../../lib/openclaw-id/types.ts";
import { openClawIdErrorToast } from "../../lib/openclaw-id/ui-error.ts";
import { projectApplicationConfig, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";

registerRouteSubtitlesEnglish();
registerEnglishCatalog(registerOpenClawIdEnglish);

type PageState = { status: OpenClawIdStatusResult; publication: OpenClawIdPublication | null };

// Opens a lazily loaded dialog; a failed load or dialog error shows one toast.
function openDialog(open: () => Promise<unknown>) {
  open().catch((error: unknown) =>
    showToast({
      severity: "error",
      message: openClawIdErrorToast(error, "open"),
      durationMs: 12_000,
    }),
  );
}

export function OpenClawIdPage() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = projectApplicationConfig(context.config);
  // Bumped after a dialog changed the claw, so the page reads it again.
  const [revision, setRevision] = createSignal(0);
  const client = createMemo(() => {
    const { snapshot } = gateway.read();
    return snapshot.phase === "connected" ? snapshot.client : null;
  });
  const enabled = createMemo(() => config.read().openclawIdEnabled === true);
  const state = createMemo(async (): Promise<PageState | null> => {
    revision();
    const current = client();
    if (!current || !enabled()) {
      return null;
    }
    const status = await current.request<OpenClawIdStatusResult>("openclawId.status", {});
    const publication =
      status.owner && status.link.linked
        ? ((await current.request<{ link: OpenClawIdPeopleLink }>("openclawId.people", {})).link
            .publication ?? null)
        : null;
    return { status, publication };
  });
  const changed = () => {
    setRevision((value) => value + 1);
    void context.sidebarAttention.refreshOpenClawId();
  };
  const peopleHref = () =>
    `${pathForRoute("plugin", context.basePath)}?${new URLSearchParams({ plugin: "openclaw-id-access", id: "access" })}`;
  return (
    <div class="openclaw-id-page">
      <SettingsPageHeader
        title={titleForRoute("openclaw-id", t)}
        subtitle={subtitleForRoute("openclaw-id", t)}
      />
      <SettingsWorkspace>
        <Errored fallback={() => <SettingsUnavailable message={t("openclawId.pageLoadFailed")} />}>
          <Loading fallback={<SettingsLoadingSkeleton rows={4} />}>
            <Show
              when={state()}
              fallback={
                <SettingsUnavailable
                  message={t(client() ? "openclawId.pageOff" : "openclawId.pageUnavailable")}
                />
              }
            >
              {(current) => (
                <Show
                  when={current().status.status.state !== "off"}
                  fallback={<SettingsUnavailable message={t("openclawId.pageOff")} />}
                >
                  <ClawSections state={current()} peopleHref={peopleHref()} onChanged={changed} />
                </Show>
              )}
            </Show>
          </Loading>
        </Errored>
      </SettingsWorkspace>
    </div>
  );
}

function ClawSections(props: { state: PageState; peopleHref: string; onChanged: () => void }) {
  const context = useApplication();
  const status = () => props.state.status;
  const local = () => status().channel === "local_operator";
  const hostname = () => (status().link.linked ? status().link.hostname : undefined);
  const openDevices = () => {
    const client = context.gateway.snapshot.client;
    if (client) {
      openDialog(() => showOwnerDevicesDialog({ client }));
    }
  };
  const moveKeys = (host: string) => {
    const client = context.gateway.snapshot.client;
    const signedIn = openClawIdAccount();
    if (!client || !signedIn) {
      showToast({ severity: "info", message: t("openclawId.keyRecoverySignIn") });
      return;
    }
    // The handler that opened the dialog captures the callback it reports to.
    const changed = props.onChanged;
    openDialog(async () => {
      if (await showMoveKeysDialog({ client, signedIn, hostname: host })) {
        changed();
      }
    });
  };
  const reset = () => {
    const client = context.gateway.snapshot.client;
    const changed = props.onChanged;
    if (client) {
      openDialog(async () => {
        if (await showResetOwnerDialog({ client, accountEmail: openClawIdAccount()?.email })) {
          changed();
        }
      });
    }
  };
  return (
    <>
      <SettingsSection title={t("openclawId.pageClaw")}>
        <Show
          when={hostname()}
          fallback={
            <SettingsRow
              title={t("openclawId.pageRemoteAccess")}
              description={t("openclawId.pageNotLinked")}
            />
          }
        >
          {(host) => (
            <>
              <SettingsRow
                title={t("openclawId.pageAddress")}
                description={clawNameFromHostname(host())}
                control={<SettingsValue value={host()} mono />}
              />
              <Show when={status().owner}>
                <SettingsRow
                  title={t("openclawId.pagePublication")}
                  control={
                    <SettingsStatus
                      kind={props.state.publication?.state === "published" ? "ok" : "warn"}
                      label={t(
                        props.state.publication?.state === "published"
                          ? "openclawId.pagePublished"
                          : "openclawId.pageNotPublished",
                      )}
                    />
                  }
                />
                <SettingsRow
                  title={t("openclawId.yourDevices")}
                  description={t("openclawId.pageDevicesDescription")}
                  control={
                    <button type="button" class="btn btn--sm" onClick={openDevices}>
                      {t("openclawId.pageOpen")}
                    </button>
                  }
                />
              </Show>
              <SettingsRow
                title={t("openclawId.pagePeople")}
                description={t("openclawId.pagePeopleDescription")}
                control={
                  <a class="btn btn--sm" href={props.peopleHref}>
                    {t("openclawId.pageOpen")}
                  </a>
                }
              />
            </>
          )}
        </Show>
      </SettingsSection>
      <Show when={hostname()}>
        {(host) => (
          <>
            <SettingsSection title={t("openclawId.pageKeys")}>
              <SettingsRow
                title={t("openclawId.moveToNewKeys")}
                description={t(
                  local()
                    ? "openclawId.pageMoveKeysDescription"
                    : "openclawId.pageMoveKeysLocalOnly",
                )}
                control={
                  local() ? (
                    <button type="button" class="btn btn--sm" onClick={() => moveKeys(host())}>
                      {t("openclawId.moveToNewKeys")}
                    </button>
                  ) : undefined
                }
              />
            </SettingsSection>
            <SettingsSection title={t("openclawId.resetOwnerAccess")} danger>
              <Switch>
                <Match when={local()}>
                  <SettingsRow
                    title={t("openclawId.resetOwnerAccess")}
                    description={t("openclawId.resetDescription")}
                    control={
                      <button type="button" class="btn btn--sm danger" onClick={reset}>
                        {t("openclawId.resetAction")}
                      </button>
                    }
                  />
                </Match>
                <Match when={!local()}>
                  <SettingsRow
                    title={t("openclawId.resetOwnerAccess")}
                    description={t("openclawId.resetLocalOnly")}
                  />
                </Match>
              </Switch>
            </SettingsSection>
          </>
        )}
      </Show>
    </>
  );
}
