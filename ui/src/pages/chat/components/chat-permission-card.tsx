import { coerceErrorMessage } from "@openclaw/normalization-core";
import { action, createMemo, createOptimistic, createSignal, Errored, Show } from "solid-js";
import type { NodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { projectNativeDeviceSettings } from "../../../lib/reactive/application-native.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export function ChatPermissionCard(props: {
  request: NodePermissionRequest;
  onRetry?: (message: string) => void;
}) {
  const native = useOptionalApplication()?.nativeDeviceSettings;
  const projection = native ? projectNativeDeviceSettings(native) : null;
  const [busy, setBusy] = createOptimistic(false);
  const [operation, setOperation] = createSignal<{ promise: Promise<undefined> }>();
  const names = (capabilities = props.request.capabilities) =>
    capabilities
      .map((id) => {
        const key = `chat.permissions.capabilities.${id}`;
        const label = t(key);
        return label === key ? id : label;
      })
      .join(", ");
  const local = () =>
    projection?.read()?.device.nodeId === props.request.nodeId && native?.resolvePermission;
  const remaining = createMemo(() => {
    const snapshot = projection?.read();
    return props.request.capabilities.filter((id) => {
      if (id === "computerControl") {
        return snapshot?.capabilities?.computerControlEnabled !== true;
      }
      if (id === "canvas") {
        return snapshot?.capabilities?.canvasEnabled !== true;
      }
      if (id === "cameraEnabled") {
        return snapshot?.capabilities?.cameraEnabled !== true;
      }
      if (id === "location" && snapshot?.permissions.location?.mode === "off") {
        return true;
      }
      const entry = snapshot?.permissions.entries.find((candidate) => candidate.id === id);
      return entry?.status !== "granted" || Boolean(entry.state);
    });
  });
  // Native cannot commit an enabled Location mode while macOS denies access.
  const disabled = createMemo(() =>
    remaining().filter(
      (id) =>
        id === "computerControl" ||
        id === "canvas" ||
        id === "cameraEnabled" ||
        (id === "location" &&
          projection?.read()?.permissions.location?.mode === "off" &&
          projection?.read()?.permissions.entries.find((entry) => entry.id === id)?.status !==
            "denied"),
    ),
  );
  const complete = () => Boolean(local()) && remaining().length === 0;
  const permissionAction = createMemo(() => {
    const snapshot = projection?.read();
    if (local()) {
      if (disabled().length > 0) {
        return { state: "disabled-in-openclaw" as const, capabilities: disabled() };
      }
      for (const candidateState of [
        "stale-grant",
        "restart-required",
        "denied",
        "not-determined",
      ] as const) {
        const capabilities = remaining().filter((id) => {
          const entry = snapshot?.permissions.entries.find((candidate) => candidate.id === id);
          return (
            entry?.state === candidateState ||
            (candidateState === "denied" && entry?.status === "denied") ||
            (candidateState === "not-determined" && entry?.status === "notDetermined")
          );
        });
        if (capabilities.length > 0) {
          return { state: candidateState, capabilities };
        }
      }
    }
    return { state: props.request.state, capabilities: remaining() };
  });
  const following = () =>
    permissionAction().state === "disabled-in-openclaw"
      ? remaining().filter((id) => !disabled().includes(id))
      : [];
  const grant = action(function* (): Generator<Promise<void>, undefined, unknown> {
    const resolvePermission = local();
    if (!resolvePermission || busy()) {
      return;
    }
    setBusy(true);
    yield resolvePermission({
      ...props.request,
      ...permissionAction(),
    });
  });
  return (
    <openclaw-chat-permission-card>
      <section
        class="chat-permission-card"
        aria-label={t("chat.permissions.title", { permissions: names() })}
      >
        <div class="chat-permission-card__heading">
          <Icon name="shieldCheck" />
          <strong>{t("chat.permissions.title", { permissions: names() })}</strong>
        </div>
        <p>
          {t("chat.permissions.neededOn", { node: props.request.nodeName ?? props.request.nodeId })}
        </p>
        <Show when={local()} fallback={<p>{t("chat.permissions.openApp")}</p>}>
          <p>
            {t(
              complete()
                ? "chat.permissions.ready"
                : `chat.permissions.states.${permissionAction().state}`,
            )}
          </p>
          <Show when={following().length > 0}>
            <p>{t("chat.permissions.following", { permissions: names(following()) })}</p>
          </Show>
          <Show
            when={complete()}
            fallback={
              <button
                class="btn primary"
                type="button"
                disabled={busy()}
                onClick={() => {
                  const pending = grant();
                  // The card can unmount before its outcome boundary observes the rejection.
                  void pending.catch(() => {});
                  setOperation({ promise: pending });
                }}
              >
                {t(`chat.permissions.actions.${permissionAction().state}`, {
                  permissions: names(permissionAction().capabilities),
                })}
              </button>
            }
          >
            <button
              class="btn primary"
              type="button"
              disabled={!props.onRetry}
              onClick={() =>
                props.onRetry?.(t("chat.permissions.retryMessage", { permissions: names() }))
              }
            >
              {t("chat.permissions.tryAgain")}
            </button>
          </Show>
        </Show>
        <Show when={!busy() && operation()} keyed>
          {({ promise }) => {
            // Only failure renders; successful native actions have no content.
            const outcome = createMemo(() => promise, { loadingValue: undefined });
            return (
              <Errored fallback={(error) => <p role="alert">{coerceErrorMessage(error())}</p>}>
                {outcome()}
              </Errored>
            );
          }}
        </Show>
      </section>
    </openclaw-chat-permission-card>
  );
}
