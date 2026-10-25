import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading } from "solid-js";
import { RetryAction } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConfigProps } from "./view-types.ts";

export function ConfigReadLoading(props: { message: string }) {
  return (
    <div class="config-loading" aria-busy="true">
      <div class="config-loading__spinner" />
      <span>{props.message}</span>
    </div>
  );
}

export function ConfigReadError(props: { message: string; onRetry: () => void }) {
  return (
    <div class="config-content-callout">
      <div class="callout danger" role="alert">
        {props.message} <RetryAction type="button" onRetry={() => props.onRetry()} />
      </div>
    </div>
  );
}

export function ConfigReadBoundary(props: {
  config: Pick<
    ConfigProps,
    "configRead" | "configLoaded" | "configRecoveryError" | "onRetryConfig"
  >;
  children: JSX.Element;
}) {
  const configResult = createMemo(() => props.config.configRead ?? undefined);
  const configReady = () => {
    // Loaded drafts and publication recovery retain the owner's editor interlocks.
    if (!props.config.configLoaded && !props.config.configRecoveryError) {
      const result = configResult();
      if (result?.ok === false) {
        throw new Error(result.error);
      }
    }
    return true;
  };
  return (
    <Loading
      on={!props.config.configLoaded ? props.config.configRead : undefined}
      fallback={<ConfigReadLoading message={t("common.loading")} />}
    >
      <Errored
        fallback={(error, reset) => (
          <ConfigReadError
            message={formatUiError(error())}
            onRetry={() => {
              props.config.onRetryConfig();
              reset();
            }}
          />
        )}
      >
        {configReady() ? props.children : null}
      </Errored>
    </Loading>
  );
}
