// Settings → Profile → Identity: link this profile to an OpenClaw ID (OCF-510). Offered only
// on a connection with a verified personal sign-in while the OpenClaw ID Labs switch is on:
// signing in there proves both sides on one connection, so the Gateway links that account to
// this profile with no picker. Owner devices of a linked account then arrive as this person.
// Linking grants nothing; owner authority still comes from each device's certificate.
import { createSignal, onSettled, Show } from "solid-js";
import { clawNameFromHostname } from "../../components/openclaw-id/claw-name.ts";
import { SettingsRow, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import { linkOpenClawIdToProfile } from "../../lib/openclaw-id/link-profile.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerProfileEnglish);

type Link = { email: string | null; owner: boolean };

export function OpenClawIdIdentity() {
  const context = useApplication();
  // undefined while loading or unavailable: the row is absent until it can act.
  const [state, setState] = createSignal<{ link: Link | null; claw: string | null }>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const client = () => context.gateway.snapshot.client;
  const load = async () => {
    const current = client();
    if (!current || openClawIdFeatureSignal().aborted) {
      setState(undefined);
      return;
    }
    const status = await current.request<OpenClawIdStatusResult>("openclawId.status", {});
    if (status.status.state === "off" || status.accountSignIn !== "device") {
      setState(undefined);
      return;
    }
    const { linked } = await current.request<{ linked: Link | null }>("openclawId.account", {
      action: "link_status",
    });
    setState({
      link: linked,
      claw: status.link.hostname ? clawNameFromHostname(status.link.hostname) : null,
    });
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
      } else if (outcome === "profile_linked") {
        setError(t("profilePage.openclawId.profileLinked"));
      } else if (outcome === "owner_profile") {
        setError(t("profilePage.openclawId.failed"));
      }
    });
  const unlink = () =>
    run(async () => {
      await client()?.request("openclawId.account", { action: "unlink" });
    });
  onSettled(() => {
    void load().catch(() => setState(undefined));
  });
  return (
    <Show when={state()}>
      {(current) => (
        <>
          <SettingsRow
            title={t("profilePage.openclawId.title")}
            description={
              <Show
                when={current().link}
                fallback={
                  <SettingsStatus kind="muted" label={t("profilePage.openclawId.notLinked")} />
                }
              >
                {(linked) => (
                  <span class="identity-account">
                    {linked().owner && current().claw
                      ? t("profilePage.openclawId.ownerOf", {
                          email: linked().email ?? t("profilePage.openclawId.title"),
                          claw: current().claw!,
                        })
                      : (linked().email ?? t("profilePage.openclawId.title"))}
                  </span>
                )}
              </Show>
            }
            control={
              <Show
                when={current().link}
                fallback={
                  <button
                    class="btn btn--sm"
                    disabled={busy()}
                    aria-label={t("profilePage.openclawId.link")}
                    onClick={() => void link()}
                  >
                    {t("profilePage.openclawId.linkShort")}
                  </button>
                }
              >
                <button class="btn btn--sm" disabled={busy()} onClick={() => void unlink()}>
                  {t("profilePage.openclawId.unlink")}
                </button>
              </Show>
            }
          />
          <Show when={error()}>
            <div class="settings-row identity-error" role="alert">
              <span class="settings-row__desc">{error()}</span>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}
