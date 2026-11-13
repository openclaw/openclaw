import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading, Show } from "solid-js";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  SettingsLoadingSkeleton,
  SettingsUnavailable,
  RetryAction,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConfigProps } from "./view-types.ts";

export function ConfigReadLoading(props: { message: string }) {
  return (
    <div class="config-loading" aria-busy="true">
      <span class="btn__spinner config-loading__spinner" aria-hidden="true" />
      <span>{props.message}</span>
    </div>
  );
}

export class ConfigReadFailure extends Error {
  constructor(
    message: string,
    readonly denied = false,
  ) {
    super(message);
  }
}

export function isConfigReadDenied(error: unknown): boolean {
  return error instanceof ConfigReadFailure && error.denied;
}

export function ConfigReadError(props: { message: string; onRetry?: () => void }) {
  return (
    <div class="config-content-callout">
      <InlineAlert tone="danger" role="alert">
        {props.message}{" "}
        {props.onRetry ? <RetryAction type="button" onRetry={() => props.onRetry?.()} /> : null}
      </InlineAlert>
    </div>
  );
}

type ConfigReadState = Pick<
  ConfigProps,
  | "configRead"
  | "configLoaded"
  | "configRecoveryError"
  | "onRetryConfig"
  | "configReadAccess"
  | "connected"
  | "loading"
>;

export function ConfigReadBoundary(props: {
  config: ConfigReadState;
  children: JSX.Element;
  fallback?: JSX.Element;
  displayReady?: boolean;
}) {
  const configResult = createMemo(() => props.config.configRead ?? undefined);
  const configReady = () => {
    // Loaded drafts and publication recovery retain the owner's editor interlocks.
    if (!props.config.configLoaded && !props.config.configRecoveryError) {
      const result = configResult();
      if (result?.ok === false) {
        throw new ConfigReadFailure(result.error, result.denied);
      }
    }
    return true;
  };
  return (
    <Show
      when={props.displayReady || props.config.configReadAccess !== "denied"}
      fallback={<SettingsUnavailable message={t("configView.readRestricted")} />}
    >
      <Show
        when={props.displayReady || props.config.connected || props.config.configLoaded}
        fallback={<SettingsUnavailable message={t("configView.readDisconnected")} />}
      >
        <Show
          when={props.displayReady}
          fallback={
            <Loading
              on={!props.config.configLoaded ? props.config.configRead : undefined}
              fallback={props.fallback ?? <ConfigReadLoading message={t("common.loading")} />}
            >
              <Errored
                fallback={(error, reset) => (
                  <ConfigReadError
                    message={formatUiError(error())}
                    onRetry={
                      isConfigReadDenied(error())
                        ? undefined
                        : () => {
                            props.config.onRetryConfig();
                            reset();
                          }
                    }
                  />
                )}
              >
                {configReady() ? props.children : null}
              </Errored>
            </Loading>
          }
        >
          {props.children}
        </Show>
      </Show>
    </Show>
  );
}

/** Keep section controls mounted while their shared config owner loads or retries. */
export function ConfigReadStatus(props: { config: ConfigReadState }) {
  const loading = () => <SettingsLoadingSkeleton rows={2} />;
  return (
    <ConfigReadBoundary config={props.config} fallback={loading()}>
      {!props.config.configLoaded && props.config.loading && !props.config.configRead
        ? loading()
        : null}
    </ConfigReadBoundary>
  );
}
