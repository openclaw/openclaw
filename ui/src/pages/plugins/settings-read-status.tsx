import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading } from "solid-js";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import type { PluginSettingsEditorModel } from "./settings-model.ts";

export function PluginSettingsReadStatus(props: {
  model: Pick<
    PluginSettingsEditorModel,
    | "configRead"
    | "configSchemaRead"
    | "configError"
    | "onConfigReadRetry"
    | "onConfigWriteRetry"
    | "configValue"
    | "configSchema"
  >;
  loading: boolean;
  rows: number;
  renderError: (error: string, retry: () => void) => JSX.Element;
}) {
  const config = createMemo(() => props.model.configRead);
  const schema = createMemo(() => props.model.configSchemaRead);
  const error = createMemo(() => props.model.configError);
  const retryRecordedError = () =>
    props.model.configValue && props.model.configSchema
      ? props.model.onConfigWriteRetry()
      : props.model.onConfigReadRetry();
  const feedback = (message: string | null, retry: () => void) => (
    <>
      {message ? props.renderError(message, retry) : null}
      {props.loading ? <SettingsLoadingSkeleton rows={props.rows} carapace /> : null}
    </>
  );
  function Status() {
    const readiness = createMemo(async () => {
      const currentError = error();
      const read = config();
      const outcomes = await Promise.all([
        read
          ? Promise.race([read.completion.promise, read.invalidated.promise.then(() => null)])
          : Promise.resolve(null),
        Promise.resolve(schema()),
      ]);
      // A later write owns its own error; completed reads cannot replace it.
      const failed = outcomes.find(
        (outcome) => outcome && !outcome.ok && outcome.error === currentError,
      );
      if (failed && !failed.ok) {
        throw new Error(failed.error);
      }
      return null;
    });
    return (
      <>
        {readiness()}
        {feedback(error(), retryRecordedError)}
      </>
    );
  }
  return (
    <Loading on={[config(), schema()]} fallback={feedback(error(), retryRecordedError)}>
      <Errored
        fallback={(failure, reset) => {
          const onRetry = () => {
            props.model.onConfigReadRetry();
            reset();
          };
          return feedback(formatUiError(failure()), onRetry);
        }}
      >
        <Status />
      </Errored>
    </Loading>
  );
}
