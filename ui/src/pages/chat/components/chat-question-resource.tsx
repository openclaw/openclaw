import type { Question } from "@openclaw/gateway-protocol";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
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
import { assertUploadsEnabled } from "../../../lib/uploads.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import { admitAttachmentFiles, resolveChatAttachmentLimits } from "./chat-attachment-admission.ts";

type ResourceProps = {
  question?: Question;
  requestId: string;
  sessionKey: string;
  agentId?: string;
  selected: ReadonlySet<string>;
  disabled: boolean;
};

/** Local presentation only; the pending question and MCP view own all resource grants. */
export const ChatQuestionResource = defineSolidBridge<ResourceProps>(
  "openclaw-chat-question-resource",
  (props, host) => {
    const context = useOptionalApplication();
    const gateway = context && projectGateway(context.gateway);
    const [operationRevision, setOperationRevision] = createSignal(0);
    const isBusy = () => {
      operationRevision();
      return Boolean(operationAbort);
    };
    const [error, setError] = createSignal("");
    const [uploaded, setUploaded] = createSignal<Array<{ uri: string; name: string }>>([]);
    const [preview, setPreview] = createSignal<{
      view?: {
        id: string;
        View: (typeof import("../../../components/mcp-app-view-registration.ts"))["McpAppView"];
      };
      text?: string;
      images?: string[];
    } | null>(null);
    let generation = 0;
    let operationAbort: AbortController | undefined;
    let live = true;
    const key = () =>
      JSON.stringify([
        props.requestId,
        props.question?.questionId,
        props.question?.resource?.viewId,
        props.sessionKey,
        props.agentId,
        context ? gatewayPresentationScope(context.gateway).key : -1,
      ]);
    let identity = untrack(key);
    createEffect(
      () => {
        gateway?.read();
        return [key(), props.disabled] as const;
      },
      ([nextIdentity, disabled]) => {
        if (nextIdentity !== identity || disabled) {
          operationAbort?.abort();
          generation++;
          if (nextIdentity !== identity) {
            setUploaded([]);
          }
          identity = nextIdentity;
          operationAbort = undefined;
          setOperationRevision((revision) => revision + 1);
          setError("");
          setPreview(null);
        }
      },
    );
    onCleanup(() => {
      live = false;
      operationAbort?.abort();
      generation++;
    });
    async function operation(
      action: (isCurrent: () => boolean) => Promise<QuestionResourceAction>,
    ) {
      const client = context?.gateway.snapshot.client;
      const question = props.question;
      if (
        !context ||
        context.gateway.snapshot.phase !== "connected" ||
        !client ||
        !question?.resource?.viewId ||
        props.disabled ||
        operationAbort ||
        !props.sessionKey
      ) {
        return;
      }
      const operationGeneration = ++generation;
      const abort = new AbortController();
      operationAbort = abort;
      const scope = gatewayPresentationScope(context.gateway).key;
      const operationIdentity = key();
      const current = () =>
        host.isConnected &&
        live &&
        !props.disabled &&
        operationGeneration === generation &&
        operationIdentity === key() &&
        context.gateway.snapshot.client === client &&
        gatewayPresentationScope(context.gateway).key === scope;
      setOperationRevision((revision) => revision + 1);
      setError("");
      try {
        const request = await action(current);
        if (!current()) {
          return;
        }
        const result = await client.request<QuestionResourceActionResult>(
          "mcp.app.formResource",
          {
            sessionKey: props.sessionKey,
            agentId: props.agentId,
            viewId: question.resource.viewId,
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
            [...uploaded(), ...result.resources].map((resource) => [resource.uri, resource]),
          );
          if (allUploaded.size > 64 || (!question.multiSelect && result.resources.length !== 1)) {
            throw new Error("Invalid resource upload count");
          }
          setUploaded([...allUploaded.values()]);
          const values = question.multiSelect ? new Set(props.selected) : new Set<string>();
          for (const resource of result.resources) {
            values.add(resource.uri);
          }
          host.dispatchEvent(
            new CustomEvent("resource-selection", {
              detail: { values: [...values] },
              bubbles: true,
              composed: true,
            }),
          );
        } else if ("preview" in result) {
          if (result.preview.viewId) {
            const { McpAppView } = await import("../../../components/mcp-app-view-registration.ts");
            if (!current()) {
              return;
            }
            setPreview({ view: { id: result.preview.viewId, View: McpAppView } });
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
          setError(formatUiError(failure));
        }
      } finally {
        if (current()) {
          operationAbort = undefined;
          setOperationRevision((revision) => revision + 1);
        }
      }
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
          files.length + untrack(uploaded).length > 64 ||
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

    const dispatchSelection = (values: string[]) =>
      host.dispatchEvent(
        new CustomEvent("resource-selection", {
          detail: { values },
          bubbles: true,
          composed: true,
        }),
      );
    return (
      <>
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
                        disabled={props.disabled || isBusy()}
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
                  disabled={props.disabled || isBusy()}
                  onChange={(event) => void upload(event.currentTarget)}
                />
              </label>
            )}
            <For each={uploaded().filter((entry) => props.selected.has(entry.uri))}>
              {(entry) => (
                <div>
                  {entry.name}
                  <button
                    class="btn btn--sm"
                    type="button"
                    disabled={props.disabled || isBusy()}
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
            {error() && <div role="alert">{error()}</div>}
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
              {(view) => <view.View sessionKey={props.sessionKey} viewId={view.id} />}
            </Show>
          </div>
        )}
      </>
    );
  },
  {
    properties: {
      question: { default: undefined, attribute: false },
      requestId: { default: "", attribute: false },
      sessionKey: { default: "", attribute: false },
      agentId: { default: undefined, attribute: false },
      selected: { default: new Set(), attribute: false },
      disabled: { default: false, type: Boolean },
    },
  },
);
