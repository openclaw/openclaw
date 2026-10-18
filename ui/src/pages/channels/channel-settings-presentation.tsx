import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "../../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  fetchWithControlUiAuth,
  readControlUiJsonResponse,
  resolveControlUiAuthCandidates,
} from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { getLocale } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { controlUiPluginDistributions } from "../../plugins/control-ui-distribution.ts";
import { createControlUiSettingsComponents } from "../../plugins/control-ui-settings-components.solid.tsx";
import { ChannelConfig } from "./view.config.tsx";
import type { ChannelSettingsPresentation, ChannelsProps } from "./view.types.ts";

export type ChannelSettingsHooks = {
  getContext: () => ApplicationContext;
  getProps: () => ChannelsProps;
  getConnection: () => GatewayPageBinding;
};

/** Encode identifiers exactly once; URL normalization must never escape the declared owner. */
function channelSettingsPath(channelId: string, accountId: string, path: readonly string[]) {
  const segments = [channelId, accountId, ...path];
  if (!path.length || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Channel Settings requests require account-relative path segments.");
  }
  const encoded = segments.map((part) => encodeURIComponent(part));
  const prefix = `/api/channels/${encoded[0]}/${encoded[1]}/`;
  const url = new URL(`/api/channels/${encoded.join("/")}`, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)) {
    throw new Error("Channel Settings request escaped its channel account.");
  }
  return url.pathname;
}

/** A channel editor belongs to this page, not the detail modal or a transport epoch. */
export function createChannelSettingsPresentation(
  hooks: ChannelSettingsHooks,
): ChannelSettingsPresentation {
  type Entry = {
    node: HTMLElement;
    abort: AbortController;
    transport: AbortController;
    epoch: number;
    identityCurrent: () => boolean;
    update?: (snapshot: ControlUiChannelSettingsSnapshot) => void;
    dispose?: () => void;
    fail?: (error: unknown) => void;
  };
  const entries = new Map<string, Entry>();
  const slots = new Map<string, HTMLElement>();
  // DOM visibility is presentation state; entry and request authority stay synchronous.
  const [presented, setPresented] = createSignal<ReadonlySet<string>>(new Set(), {
    ownedWrite: true,
  });
  let disposed = false;
  const has = (channelId: string) =>
    controlUiPluginDistributions.some((distribution) =>
      distribution.settingsViews?.some(
        (view) => view.section === "channels" && view.channelId === channelId,
      ),
    );
  const snapshot = (channelId: string): ControlUiChannelSettingsSnapshot => {
    const props = hooks.getProps();
    const allAccounts = props.channels.channelsSnapshot?.channelAccounts;
    const accounts =
      allAccounts && Object.hasOwn(allAccounts, channelId) ? allAccounts[channelId] : undefined;
    return {
      channelId,
      status: props.channels.channelsSnapshot?.channels[channelId],
      defaultAccountId: props.channels.channelsSnapshot?.channelDefaultAccountId[channelId],
      ...(channelId === "whatsapp"
        ? {
            login: {
              message: props.channels.whatsappLoginMessage,
              qrDataUrl: props.channels.whatsappLoginQrDataUrl,
              connected: props.channels.whatsappLoginConnected,
              busy: props.channels.whatsappBusy,
            },
          }
        : {}),
      accounts: Array.isArray(accounts) ? accounts : [],
      connected: hooks.getContext().gateway.snapshot.phase === "connected",
      canAdmin: props.canAdmin,
      connectionEpoch: hooks.getConnection().epoch,
      locale: getLocale(),
      presented: slots.has(channelId),
    };
  };
  function retire(channelId: string) {
    const entry = entries.get(channelId);
    entries.delete(channelId);
    if (!entry) {
      return;
    }
    entry.abort.abort();
    entry.transport.abort();
    try {
      entry.dispose?.();
    } finally {
      entry.node.remove();
    }
  }
  function ensure(channelId: string) {
    const existing = entries.get(channelId);
    if (existing) {
      return existing;
    }
    const application = hooks.getContext();
    const { gateway, channels, plugins, runtimeConfig } = application;
    const client = gateway.snapshot.client;
    const canAdmin = hooks.getProps().canAdmin;
    const entry: Entry = {
      node: document.createElement("div"),
      abort: new AbortController(),
      transport: new AbortController(),
      epoch: hooks.getConnection().epoch,
      identityCurrent: () =>
        !disposed &&
        hooks.getContext().gateway === gateway &&
        hooks.getContext().channels === channels &&
        hooks.getContext().plugins === plugins &&
        hooks.getContext().runtimeConfig === runtimeConfig &&
        gateway.snapshot.client === client &&
        hooks.getProps().canAdmin === canAdmin,
    };
    entry.node.style.display = "contents";
    entries.set(channelId, entry);
    const current = () => {
      entry.abort.signal.throwIfAborted();
      if (entries.get(channelId) !== entry || !entry.identityCurrent()) {
        throw new DOMException("Channel Settings presentation has ended", "AbortError");
      }
    };
    const fail = (error: unknown) => {
      if (entries.get(channelId) !== entry || entry.abort.signal.aborted) {
        return;
      }
      entry.abort.abort();
      entry.transport.abort();
      entry.dispose?.();
      entry.dispose = undefined;
      entry.update = undefined;
      entry.node.replaceChildren(formatUiError(error, "Settings presentation could not load."));
    };
    entry.fail = fail;
    void plugins
      .loadSettingsView({ section: "channels", panel: "detail", channelId }, entry.abort.signal)
      .then((loaded) => {
        current();
        const stop = listen(
          loaded.signal,
          "abort",
          () => {
            entry.abort.abort();
            entry.transport.abort();
            entry.dispose?.();
            entry.dispose = undefined;
          },
          { once: true },
        );
        const captureAction = () => {
          current();
          const connection = hooks.getConnection();
          const scope = connection.capture();
          const signal = AbortSignal.any([loaded.signal, entry.transport.signal]);
          const assertCurrent = () => {
            signal.throwIfAborted();
            current();
            if (
              !scope ||
              !connection.isCurrent(scope) ||
              gateway.snapshot.phase !== "connected" ||
              !hasOperatorAdminAccess(gateway.snapshot.hello?.auth ?? null)
            ) {
              throw new DOMException("Channel Settings action has ended", "AbortError");
            }
          };
          assertCurrent();
          return { signal, assertCurrent };
        };
        const logoutAccount = () => {
          const wizardAccountId = hooks.getProps().wizardHost.whatsappAccountId();
          const status = channels.state.channelsSnapshot;
          const accountId =
            wizardAccountId ?? status?.channelDefaultAccountId.whatsapp ?? "default";
          const account = resolveChannelAccounts(status?.channelAccounts, channelId).find(
            (candidate) => candidate.accountId === accountId,
          );
          if (!account && wizardAccountId !== undefined) {
            return null;
          }
          return {
            accountId,
            linked:
              account?.linked ??
              (wizardAccountId === undefined
                ? asNullableRecord(status?.channels[channelId])?.linked
                : undefined),
          };
        };
        const context: ControlUiChannelSettingsContext = {
          signal: loaded.signal,
          props: snapshot(channelId),
          components: createControlUiSettingsComponents(loaded.signal),
          async request(request) {
            current();
            if (request.method !== "PUT" && request.method !== "POST") {
              throw new Error("Unsupported channel Settings method.");
            }
            const connection = hooks.getConnection();
            const scope = connection.capture();
            const signal = AbortSignal.any([loaded.signal, entry.transport.signal, request.signal]);
            const admitted = () => {
              signal.throwIfAborted();
              current();
              return (
                scope !== null &&
                connection.isCurrent(scope) &&
                gateway.snapshot.phase === "connected" &&
                hasOperatorAdminAccess(gateway.snapshot.hello?.auth ?? null)
              );
            };
            if (!admitted()) {
              throw new Error("Channel Settings requires a connected administrator.");
            }
            const authCandidates = resolveControlUiAuthCandidates({
              hello: gateway.snapshot.hello,
              settings: { token: gateway.connection.token },
              password: gateway.connection.password,
            });
            const response = await fetchWithControlUiAuth(
              channelSettingsPath(channelId, request.accountId, request.path),
              {
                method: request.method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request.body),
                signal,
              },
              authCandidates,
              admitted,
            );
            const result = await readControlUiJsonResponse(response, signal);
            if (!admitted()) {
              throw new DOMException("Channel Settings request has ended", "AbortError");
            }
            return {
              ok: response.ok,
              status: response.status,
              data: result.data,
              errorMessage: result.errorMessage,
            };
          },
          ...(channelId === "whatsapp"
            ? {
                login: {
                  async start(force: boolean) {
                    captureAction().assertCurrent();
                    await channels.startWhatsApp(
                      force,
                      hooks.getProps().wizardHost.whatsappAccountId(),
                    );
                  },
                  async wait() {
                    captureAction().assertCurrent();
                    await channels.waitWhatsApp(hooks.getProps().wizardHost.whatsappAccountId());
                  },
                  captureLogout() {
                    const { assertCurrent } = captureAction();
                    const account = logoutAccount();
                    if (!account) {
                      return null;
                    }
                    return {
                      accountId: account.accountId,
                      async logout() {
                        assertCurrent();
                        const latest = logoutAccount();
                        if (
                          !latest ||
                          latest.accountId !== account.accountId ||
                          latest.linked !== account.linked
                        ) {
                          return;
                        }
                        await channels.logoutWhatsApp(account.accountId);
                      },
                    };
                  },
                },
              }
            : {}),
          async confirm(options) {
            const { signal, assertCurrent } = captureAction();
            const confirmed = await showConfirmDialog({
              title: options.title,
              message: options.message,
              confirmLabel: options.confirmLabel,
              danger: options.danger,
              signal,
            });
            assertCurrent();
            return confirmed;
          },
          formatPhoneNumber(value) {
            current();
            return formatInternationalPhoneNumberForDisplay(value, getLocale()) ?? value;
          },
          formatDuration(milliseconds) {
            current();
            return formatDurationHuman(milliseconds);
          },
          mountConfig(container) {
            current();
            const stopConfig = render(() => {
              const props = createParkedProjection(
                () => ({
                  ...hooks.getProps(),
                  onConfigPatch(path: Array<string | number>, value: unknown) {
                    current();
                    hooks.getProps().onConfigPatch(path, value);
                  },
                  onConfigSave() {
                    current();
                    hooks.getProps().onConfigSave();
                  },
                  onConfigReload() {
                    current();
                    hooks.getProps().onConfigReload();
                  },
                  onShowAdvancedSettings(enabled: boolean) {
                    current();
                    hooks.getProps().onShowAdvancedSettings(enabled);
                  },
                }),
                () => presented().has(channelId),
              );
              return <ChannelConfig channelId={channelId} props={props()} />;
            }, container);
            let mounted = true;
            const dispose = () => {
              if (!mounted) {
                return;
              }
              mounted = false;
              stopAbort();
              stopConfig();
            };
            const stopAbort = listen(loaded.signal, "abort", dispose, { once: true });
            return dispose;
          },
          async refresh(probe) {
            current();
            if (gateway.snapshot.phase !== "connected") {
              return;
            }
            await channels.refresh(probe);
          },
          formatRelativeTimestamp(timestamp) {
            current();
            return formatRelativeTimestamp(timestamp);
          },
          formatError(error) {
            current();
            return formatUiError(error);
          },
          formatExternalText(text) {
            current();
            return formatUiExternalText(text);
          },
        };
        const mounted = loaded.view.mount(entry.node, context);
        let active = true;
        entry.dispose = () => {
          if (!active) {
            return;
          }
          active = false;
          stop();
          try {
            mounted.dispose();
          } finally {
            loaded.dispose();
          }
        };
        current();
        entry.update = mounted.update;
        mounted.update(snapshot(channelId));
      })
      .catch(fail);
    return entry;
  }
  function sync() {
    for (const [channelId, entry] of entries) {
      if (!entry.identityCurrent()) {
        retire(channelId);
        continue;
      }
      const props = snapshot(channelId);
      if (entry.epoch !== props.connectionEpoch) {
        entry.transport.abort();
        entry.transport = new AbortController();
        entry.epoch = props.connectionEpoch;
      }
      try {
        entry.update?.(props);
      } catch (error) {
        entry.fail?.(error);
      }
    }
    for (const [channelId, slot] of slots) {
      const entry = ensure(channelId);
      if (entry.node.parentNode !== slot) {
        slot.replaceChildren(entry.node);
      }
    }
  }
  function reset() {
    for (const channelId of entries.keys()) {
      retire(channelId);
    }
  }
  onCleanup(() => {
    disposed = true;
    slots.clear();
    reset();
  });
  return {
    has,
    sync,
    reset,
    attach(channelId: string, container: HTMLElement) {
      slots.set(channelId, container);
      setPresented(new Set(slots.keys()));
      sync();
      return () => {
        if (slots.get(channelId) === container) {
          slots.delete(channelId);
          setPresented(new Set(slots.keys()));
          entries.get(channelId)?.node.remove();
          sync();
        }
      };
    },
  };
}

export function ChannelSettingsSlot(props: {
  channelId: string;
  presentation: ChannelSettingsPresentation;
}) {
  let container!: HTMLDivElement;
  onSettled(() => props.presentation.attach(props.channelId, container));
  createEffect(getLocale, () => props.presentation.sync());
  return (
    <div
      style={{ display: "contents" }}
      ref={(node) => {
        container = node;
      }}
    />
  );
}
