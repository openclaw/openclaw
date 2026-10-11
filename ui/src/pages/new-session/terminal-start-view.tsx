import { For } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import type { NewSessionTerminalHostOptions } from "./terminal-start.ts";

export function NewSessionTerminalHost(props: { params: NewSessionTerminalHostOptions }) {
  const hostValue = liveValue(() => props.params.hostId);
  const hidden = () =>
    !props.params.hosts ||
    (props.params.hosts.length === 1 && props.params.hosts[0]?.hostId === props.params.hostId);
  return (
    <>
      {hidden() ? undefined : !props.params.hosts?.length ? (
        <span class="new-session-page__catalog-unavailable" role="status">
          {t("newSession.nativeHostsUnavailable")}
        </span>
      ) : (
        <div class="new-session-page__select new-session-page__menu-field">
          <span>{t("newSession.where")}</span>
          <select
            class="new-session-page__trigger"
            aria-label={t("newSession.where")}
            ref={hostValue}
            disabled={props.params.submitting}
            onChange={(event) => props.params.onSelect(event.currentTarget.value)}
          >
            {!props.params.hosts?.some((host) => host.hostId === props.params.hostId) ? (
              <option value={props.params.hostId} selected disabled>
                {t("newSession.chooseNativeHost")}
              </option>
            ) : undefined}
            <For each={props.params.hosts} keyed={(host) => host.hostId}>
              {(host) => (
                <option value={host().hostId} selected={host().hostId === props.params.hostId}>
                  {host().label}
                </option>
              )}
            </For>
          </select>
        </div>
      )}
    </>
  );
}
