// Settings → Profile → Identity: link this profile to an OpenClaw ID (OCF-510). Shown while the
// OpenClaw ID Labs switch is on; linking is offered only on a connection with a verified
// personal sign-in. Signing in there proves both sides on one connection, so the Gateway links
// that account to this profile with no picker. Owner devices of a linked account then arrive
// as this person. Linking grants nothing; owner authority still comes from each device's
// certificate.
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { clawNameFromHostname } from "../../components/openclaw-id/claw-name.ts";
import { RetryAction, SettingsRow, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import { linkOpenClawIdToProfile } from "../../lib/openclaw-id/link-profile.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerProfileEnglish);

type Link = { email: string | null; owner: boolean };
// The row keeps its place from first paint while Labs is on: it loads, then offers linking,
// says where linking works, or reports a failed load with a retry.
type RowState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "ready"; links: Link[]; claw: string | null };

export function OpenClawIdIdentity() {
  const context = useApplication();
  const [state, setState] = createSignal<RowState>(
    openClawIdFeatureSignal().aborted ? { kind: "off" } : { kind: "loading" },
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const client = () => context.gateway.snapshot.client;
  const load = async () => {
    const current = client();
    if (!current || openClawIdFeatureSignal().aborted) {
      setState({ kind: "off" });
      return;
    }
    const status = await current.request<OpenClawIdStatusResult>("openclawId.status", {});
    if (status.status.state === "off") {
      setState({ kind: "off" });
      return;
    }
    if (status.accountSignIn !== "device") {
      setState({ kind: "unavailable" });
      return;
    }
    const { linked } = await current.request<{ linked: Link[] }>("openclawId.account", {
      action: "link_status",
    });
    setState({
      kind: "ready",
      links: linked,
      claw: status.link.hostname ? clawNameFromHostname(status.link.hostname) : null,
    });
  };
  const reload = () => {
    setState({ kind: "loading" });
    void load().catch(() => setState({ kind: "failed" }));
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(
        formatUiError(cause instanceof Error ? cause.message : t("profilePage.openclawId.failed")),
      );
    } finally {
      setBusy(false);
    }
  };
  const link = () =>
    run(async () => {
      const current = client();
      if (!current) {
        return;
      }
      const outcome = await linkOpenClawIdToProfile(current);
      if (outcome === "linked_elsewhere") {
        setError(t("profilePage.openclawId.linkedElsewhere"));
      } else if (outcome === "owner_profile" || outcome === "profile_changed") {
        setError(t("profilePage.openclawId.failed"));
      }
    });
  const unlink = () =>
    run(async () => {
      await client()?.request("openclawId.account", { action: "unlink" });
    });
  const label = (linked: Link, claw: string | null) => {
    const email = linked.email ?? t("profilePage.openclawId.title");
    return linked.owner && claw ? t("profilePage.openclawId.ownerOf", { email, claw }) : email;
  };
  const ready = () => {
    const current = state();
    return current.kind === "ready" ? current : undefined;
  };
  onSettled(reload);
  const linkButton = (disabled: boolean) => (
    <button
      class="btn btn--sm"
      disabled={disabled}
      aria-label={t("profilePage.openclawId.link")}
      onClick={() => void link()}
    >
      {t("profilePage.openclawId.linkShort")}
    </button>
  );
  return (
    <Show when={state().kind !== "off"}>
      <SettingsRow
        title={t("profilePage.openclawId.title")}
        description={
          <Switch>
            <Match when={state().kind === "loading"}>
              <SettingsStatus kind="muted" label={t("common.loading")} />
            </Match>
            <Match when={state().kind === "unavailable"}>
              <SettingsStatus kind="muted" label={t("profilePage.openclawId.unavailable")} />
            </Match>
            <Match when={state().kind === "failed"}>
              <SettingsStatus kind="danger" label={t("profilePage.openclawId.loadFailed")} />
            </Match>
            <Match when={ready()}>
              {(current) => (
                <Show
                  when={current().links.length > 0}
                  fallback={
                    <SettingsStatus kind="muted" label={t("profilePage.openclawId.notLinked")} />
                  }
                >
                  <span class="identity-emails">
                    <For each={current().links}>
                      {(linked) => (
                        <span class="identity-account">{label(linked, current().claw)}</span>
                      )}
                    </For>
                  </span>
                </Show>
              )}
            </Match>
          </Switch>
        }
        control={
          <Switch fallback={linkButton(true)}>
            <Match when={state().kind === "failed"}>
              <RetryAction onRetry={reload} />
            </Match>
            <Match when={state().kind === "unavailable"}>{null}</Match>
            <Match when={ready()}>
              {(current) => (
                <Show when={current().links.length > 0} fallback={linkButton(busy())}>
                  <button class="btn btn--sm" disabled={busy()} onClick={() => void unlink()}>
                    {t("profilePage.openclawId.unlink")}
                  </button>
                </Show>
              )}
            </Match>
          </Switch>
        }
      />
      <Show when={error()}>
        <div class="settings-row identity-error" role="alert">
          <span class="settings-row__desc">{error()}</span>
        </div>
      </Show>
    </Show>
  );
}
