import type { Question } from "@openclaw/gateway-protocol";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  createStore,
  Errored,
  For,
  lazy,
  Loading,
  onSettled,
  reconcile,
  Show,
} from "solid-js";
import { isQuestionThumbnail } from "../../../../../packages/gateway-protocol/src/question-media.js";
import type {
  QuestionResourceAction,
  QuestionResourceActionResult,
} from "../../../../../packages/gateway-protocol/src/question-resource.js";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { assertUploadsEnabled } from "../../../lib/uploads.ts";
import { admitAttachmentFiles, resolveChatAttachmentLimits } from "./chat-attachment-admission.ts";

type ResourceProps = {
  question?: Question;
  requestId: string;
  sessionKey: string;
  agentId?: string;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSelection?: (values: string[]) => void;
};

type OperationScope = { live: boolean; abort: AbortController | undefined };

const ResourcePreview = lazy(() => import("../../../components/mcp-app-view-registration.ts"), {
  export: "McpAppView",
});

/** Local presentation only; the pending question and MCP view own all resource grants. */
export function ChatQuestionResource(props: ResourceProps) {
  let host!: HTMLElement;
  const context = useOptionalApplication();
  const gateway = context && projectGateway(context.gateway);
  const [isBusy, setBusy] = createOptimistic(false);
  const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
  // Outcome observation must not hold the controls presenting the admitted operation.
  const outcome = createMemo(() => attempt()?.result.then(() => null), { loadingValue: undefined });
  const [uploaded, setUploaded] = createStore<Array<{ uri: string; name: string }>>([]);
  const [preview, setPreview] = createSignal<{
    view?: { id: string };
    text?: string;
    images?: string[];
  } | null>(null);
  let operationScope: OperationScope | undefined;
  const key = () =>
    JSON.stringify([
      props.requestId,
      props.question?.questionId,
      props.question?.resource?.viewId,
      props.sessionKey,
      props.agentId,
      context ? gatewayPresentationScope(context.gateway).key : -1,
    ]);
  const identity = createMemo(() => {
    gateway?.read();
    return key();
  });
  const presentOperation = action(function* (pending: Promise<void>, signal: AbortSignal) {
    if (signal.aborted) {
      return;
    }
    const retired = Promise.withResolvers<void>();
    const stop = listen(signal, "abort", () => retired.resolve(), { once: true });
    setBusy(true);
    try {
      yield Promise.race([pending, retired.promise]);
    } finally {
      stop();
    }
  });
  async function operation(prepare: (isCurrent: () => boolean) => Promise<QuestionResourceAction>) {
    const client = context?.gateway.snapshot.client;
    const question = props.question;
    const active = operationScope;
    if (
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      !client ||
      !question?.resource?.viewId ||
      props.disabled ||
      !active?.live ||
      active.abort ||
      !props.sessionKey
    ) {
      return;
    }
    const viewId = question.resource.viewId;
    const abort = new AbortController();
    active.abort = abort;
    const scope = gatewayPresentationScope(context.gateway).key;
    const operationIdentity = key();
    const current = () =>
      host.isConnected &&
      active.live &&
      !props.disabled &&
      operationIdentity === key() &&
      context.gateway.snapshot.client === client &&
      gatewayPresentationScope(context.gateway).key === scope;
    const pending = (async () => {
      try {
        const request = await prepare(current);
        if (!current()) {
          return;
        }
        const result = await client.request<QuestionResourceActionResult>(
          "mcp.app.formResource",
          {
            sessionKey: props.sessionKey,
            agentId: props.agentId,
            viewId,
            requestId: props.requestId,
            questionId: question.questionId,
            ...request,
          },
          { signal: abort.signal },
        );
        if (!current()) {
          return;
        }
        if ("resources" in result) {
          if (
            !Array.isArray(result.resources) ||
            result.resources.length > 64 ||
            !result.resources.every(
              (resource) =>
                typeof resource.uri === "string" &&
                resource.uri.length <= 2048 &&
                typeof resource.name === "string",
            )
          ) {
            throw new Error("Invalid resource upload result");
          }
          const allUploaded = new Map(
            [...uploaded, ...result.resources].map((resource) => [resource.uri, resource]),
          );
          if (allUploaded.size > 64 || (!question.multiSelect && result.resources.length !== 1)) {
            throw new Error("Invalid resource upload count");
          }
          setUploaded(reconcile([...allUploaded.values()], "uri"));
          const values = question.multiSelect ? new Set(props.selected) : new Set<string>();
          for (const resource of result.resources) {
            values.add(resource.uri);
          }
          dispatchSelection([...values]);
        } else if ("preview" in result) {
          if (result.preview.viewId) {
            // Keep the previous preview and operation busy until its renderer is ready.
            await ResourcePreview.preload();
            if (!current()) {
              return;
            }
            setPreview({ view: { id: result.preview.viewId } });
          } else {
            const text = result.preview.contents?.map((entry) => entry.text ?? "").join("\n") ?? "";
            const images = result.preview.contents
              ?.flatMap((entry) => {
                const url =
                  entry.blob && entry.mimeType
                    ? `data:${entry.mimeType};base64,${entry.blob}`
                    : undefined;
                return isQuestionThumbnail(url) ? [url] : [];
              })
              .slice(0, 4);
            setPreview({ text: text.slice(0, 65536), images });
          }
        }
      } catch (failure) {
        if (current()) {
          throw failure;
        }
      } finally {
        if (current()) {
          active.abort = undefined;
        }
      }
    })();
    // The scoped boundary may retire before it observes this attempt's rejection.
    void pending.catch(() => {});
    setAttempt({ result: pending });
    await Promise.resolve();
    await presentOperation(pending, abort.signal).catch(() => {});
  }

  async function upload(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) {
      return;
    }
    await operation(async (current) => {
      assertUploadsEnabled(context?.config);
      const limits = resolveChatAttachmentLimits(context?.gateway.snapshot.hello?.policy);
      if (
        !limits ||
        files.length + uploaded.length > 64 ||
        admitAttachmentFiles(files, limits, 0).length !== files.length
      ) {
        throw new Error(t("chat.questions.resourceUploadTooLarge"));
      }
      const payload: Extract<QuestionResourceAction, { action: "upload" }>["files"] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!current()) {
          throw new Error("Resource upload cancelled");
        }
        assertUploadsEnabled(context?.config);
        payload.push({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          content: bytesToBase64(bytes),
          ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}),
        });
      }
      return { action: "upload", files: payload };
    });
  }

  const dispatchSelection = (values: string[]) => props.onSelection?.(values);
  return (
    <openclaw-chat-question-resource
      ref={(element) => {
        host = element;
      }}
    >
      {/* Request scope owns uploads; disabled transitions retire only operation state. */}
      <For each={[identity()]}>
        {() => {
          onSettled(() => {
            setUploaded(() => []);
          });
          return (
            <For each={[props.disabled]}>
              {() => {
                onSettled(() => {
                  const next: OperationScope = { live: true, abort: undefined };
                  operationScope = next;
                  setAttempt(undefined);
                  setPreview(null);
                  return () => {
                    next.live = false;
                    next.abort?.abort();
                  };
                });
                return null;
              }}
            </For>
          );
        }}
      </For>
      {props.question?.resource?.viewId && (
        <div class="chat-question-panel__resource-actions">
          <For each={props.question.options}>
            {(option, index) => (
              <>
                {option.preview &&
                  (props.question!.resource!.selection !== "implicit" ||
                    props.selected.has(option.value ?? option.label)) && (
                    <button
                      class="btn btn--sm"
                      type="button"
                      disabled={isBusy() || props.disabled}
                      onClick={() =>
                        void operation(async () => ({ action: "preview", optionIndex: index() }))
                      }
                    >
                      {t("chat.questions.resourcePreview")}: {option.label}
                    </button>
                  )}
              </>
            )}
          </For>
          {props.question.resource.userOptions && (
            <label class="field">
              <span>{props.question.header}</span>
              <input
                type="file"
                aria-label={props.question.header}
                multiple={
                  props.question.multiSelect ||
                  props.question.resource.userOptions.kind === "directory"
                }
                accept={props.question.resource.userOptions.accept?.join(",")}
                webkitdirectory={props.question.resource.userOptions.kind === "directory"}
                disabled={isBusy() || props.disabled}
                onChange={(event) => void upload(event.currentTarget)}
              />
            </label>
          )}
          <For each={uploaded.filter((entry) => props.selected.has(entry.uri))}>
            {(entry) => (
              <div>
                {entry.name}
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={isBusy() || props.disabled}
                  onClick={() =>
                    dispatchSelection([...props.selected].filter((value) => value !== entry.uri))
                  }
                >
                  {t("common.remove")}
                </button>
              </div>
            )}
          </For>
          {isBusy() && <div role="status">{t("common.loading")}</div>}
          <Show when={!isBusy()}>
            <Errored fallback={(error) => <div role="alert">{formatUiError(error())}</div>}>
              {outcome()}
            </Errored>
          </Show>
          <Show
            when={preview()?.view}
            keyed
            fallback={
              preview() && (
                <>
                  <For each={preview()?.images}>
                    {(src) => (
                      <img
                        class="chat-question-panel__resource-image"
                        src={src}
                        alt={props.question!.header}
                      />
                    )}
                  </For>
                  <pre class="chat-question-panel__resource-preview">{preview()?.text}</pre>
                </>
              )
            }
          >
            {(view) => (
              <Loading>
                <ResourcePreview sessionKey={props.sessionKey} viewId={view.id} />
              </Loading>
            )}
          </Show>
        </div>
      )}
    </openclaw-chat-question-resource>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-question-resource": HTMLAttributes<HTMLElement>;
    }
  }
}
