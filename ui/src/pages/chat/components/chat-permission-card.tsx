import { html } from "lit";
import { createMemo, createSignal, Show } from "solid-js";
import type { NodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { projectNativeDeviceSettings } from "../../../lib/reactive/application-native.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";

export function renderChatPermissionCard(
  request: NodePermissionRequest,
  onRetry?: (message: string) => void,
) {
  // Some transcript leaves mount independent Solid roots. The bridge recovers the app's DOM context.
  return html`<openclaw-chat-permission-card
    .request=${request}
    .onRetry=${onRetry}
  ></openclaw-chat-permission-card>`;
}

export function ChatPermissionCard(props: {
  request: NodePermissionRequest;
  onRetry?: (message: string) => void;
}) {
  const native = useOptionalApplication()?.nativeDeviceSettings;
  const projection = native ? projectNativeDeviceSettings(native) : null;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const names = () =>
    props.request.capabilities
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
      if (id === "camera" && snapshot?.capabilities?.cameraEnabled === false) return true;
      if (id === "location" && snapshot?.permissions.location?.mode === "off") return true;
      const entry = snapshot?.permissions.entries.find((entry) => entry.id === id);
      return entry?.status !== "granted" || Boolean(entry.state);
    });
  });
  const complete = () => Boolean(local()) && remaining().length === 0;
  const state = () => {
    const snapshot = projection?.read();
    if (local()) {
      if (
        remaining().includes("computerControl") ||
        remaining().includes("canvas") ||
        (remaining().includes("camera") && snapshot?.capabilities?.cameraEnabled === false) ||
        (remaining().includes("location") && snapshot?.permissions.location?.mode === "off")
      ) {
        return "disabled-in-openclaw";
      }
      const entries =
        snapshot?.permissions.entries.filter((entry) => remaining().includes(entry.id)) ?? [];
      for (const state of [
        "stale-grant",
        "restart-required",
        "denied",
        "not-determined",
      ] as const) {
        if (
          entries.some(
            (entry) =>
              entry.state === state ||
              (state === "denied" && entry.status === "denied") ||
              (state === "not-determined" && entry.status === "notDetermined"),
          )
        )
          return state;
      }
    }
    return props.request.state;
  };
  const grant = async () => {
    if (!local() || busy()) return;
    setBusy(true);
    setError("");
    try {
      await native?.resolvePermission?.({
        ...props.request,
        capabilities: remaining(),
        state: state(),
      });
      native?.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
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
        <p>{t(complete() ? "chat.permissions.ready" : `chat.permissions.states.${state()}`)}</p>
        <Show
          when={complete()}
          fallback={
            <button
              class="btn primary"
              type="button"
              disabled={busy()}
              onClick={() => void grant()}
            >
              {t(
                state() === "restart-required"
                  ? "chat.permissions.relaunch"
                  : "chat.permissions.grant",
                { permissions: names() },
              )}
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
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}

defineSolidBridge<{ request: NodePermissionRequest | null; onRetry?: (message: string) => void }>(
  "openclaw-chat-permission-card",
  (props) => (
    <Show when={props.request}>
      {(request) => <ChatPermissionCard request={request()} onRetry={props.onRetry} />}
    </Show>
  ),
  {
    properties: {
      request: { default: null, attribute: false },
      onRetry: { default: undefined, attribute: false },
    },
  },
);
