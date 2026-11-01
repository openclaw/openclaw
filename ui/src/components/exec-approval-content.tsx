import { Show, createMemo, createUniqueId, onSettled } from "solid-js";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import { normalizeCommandSpans } from "../../../src/shared/exec-approval-command-spans.ts";
import { summarizeApprovalScopeLabel } from "../app/approval-presentation.ts";
import type { ExecApprovalRequest, ExecApprovalRequestPayload } from "../app/exec-approval.ts";
import { t } from "../lib/reactive/i18n.ts";
import { shortenOpaqueIdRuns } from "../lib/session-display.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import { Icon } from "./solid/icon.tsx";
import { Popover } from "./solid/popover.tsx";
import { useScrollState } from "./solid/scroll-state.ts";

function ExecApprovalHost(props: {
  request: ExecApprovalRequestPayload;
  nodeDisplayName?: string;
}) {
  return (
    <span
      class="exec-approval-host"
      title={props.request.host === "node" ? (props.request.nodeId ?? undefined) : undefined}
    >
      {props.request.host === "sandbox"
        ? t("execApproval.labels.sandbox")
        : props.request.host === "node"
          ? props.nodeDisplayName ||
            (props.request.nodeId
              ? shortenOpaqueIdRuns(props.request.nodeId)
              : t("execApproval.labels.node"))
          : props.request.host}
    </span>
  );
}

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return undefined;
  }
  return (
    <div class="exec-approval-meta-row">
      <span>{label}</span>
      <span>{opts?.path ? formatApprovalDisplayPath(value) : value}</span>
    </div>
  );
}

function ExecApprovalHostDetails(props: {
  request: ExecApprovalRequestPayload;
  nodeDisplayName?: string;
}) {
  return (
    <>
      <Show when={props.request.host}>
        <div class="exec-approval-meta-row">
          <span>{t("execApproval.labels.host")}</span>
          <ExecApprovalHost request={props.request} nodeDisplayName={props.nodeDisplayName} />
        </div>
      </Show>
      {props.request.host === "node"
        ? renderMetaRow(t("execApproval.labels.node"), props.request.nodeId)
        : undefined}
    </>
  );
}

function ExecApprovalDetailRows(props: {
  request: ExecApprovalRequestPayload;
  lastError?: string;
}) {
  return (
    <>
      {renderMetaRow(t("execApproval.labels.resolved"), props.request.resolvedPath, { path: true })}
      {renderMetaRow(t("execApproval.labels.security"), props.request.security)}
      {renderMetaRow(t("execApproval.labels.ask"), props.request.ask)}
      {props.request.scope?.kind === "standing-grant"
        ? renderMetaRow(
            t("execApproval.labels.scope"),
            summarizeApprovalScopeLabel(props.request.scope),
          )
        : undefined}
      {renderMetaRow(t("execApproval.labels.lastError"), props.lastError)}
    </>
  );
}

function ExecApprovalCommand(props: {
  request: ExecApprovalRequestPayload;
  scrollState?: (element: HTMLDivElement) => void;
}) {
  const parts = createMemo(() => {
    const request = props.request;
    const spans =
      normalizeCommandSpans([...(request.commandSpans ?? [])], request.command.length) ?? [];
    const result = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.startIndex > cursor) {
        result.push(request.command.slice(cursor, span.startIndex));
      }
      result.push(
        <mark class="exec-approval-command-span">
          {request.command.slice(span.startIndex, span.endIndex)}
        </mark>,
      );
      cursor = span.endIndex;
    }
    if (cursor < request.command.length) {
      result.push(request.command.slice(cursor));
    }
    return result;
  });
  return (
    <div class="exec-approval-command mono" ref={props.scrollState}>
      {parts()}
    </div>
  );
}

function renderDetails(content: SolidJSX.Element) {
  return (
    <details class="exec-approval-details">
      <summary>{t("execApproval.details")}</summary>
      <div class="exec-approval-meta">{content}</div>
    </details>
  );
}

export function ExecApprovalBody(props: {
  request: ExecApprovalRequestPayload;
  variant: "inline" | "modal";
  positionAnchor?: HTMLElement;
  nodeDisplayName?: string;
  lastError?: string;
}) {
  const detailsId = createUniqueId();
  const destination = () =>
    props.request.host === "node" && (props.nodeDisplayName || props.request.nodeId);
  return (
    <div class="exec-approval-terminal">
      <div class="exec-approval-shell mono">
        <Show when={destination() || props.request.cwd}>
          <div class="exec-approval-prompt">
            <Show when={destination()}>
              <span>
                <span class="sr-only">{t("execApproval.labels.host")}: </span>
                <ExecApprovalHost request={props.request} nodeDisplayName={props.nodeDisplayName} />
              </span>
            </Show>
            <Show when={props.request.cwd}>
              <span class="exec-approval-cwd muted">
                <span class="sr-only">{t("execApproval.labels.directory")}: </span>
                {formatApprovalDisplayPath(props.request.cwd!)}
              </span>
            </Show>
          </div>
        </Show>
        <div class="exec-approval-command-line">
          <span class="exec-approval-sigil" aria-hidden="true">
            $
          </span>
          <ExecApprovalCommand request={props.request} />
        </div>
      </div>
      <Show
        when={
          props.lastError ||
          props.request.host ||
          props.request.resolvedPath ||
          props.request.ask ||
          props.request.security ||
          props.request.scope?.kind === "standing-grant" ||
          (props.variant === "modal" && props.request.sessionKey)
        }
      >
        <Popover
          id={detailsId}
          label={t("execApproval.requestDetails")}
          triggerTitle={t("execApproval.requestDetails")}
          trigger={<Icon name="info" />}
          triggerClass={[
            "btn btn--sm btn--icon btn--ghost exec-approval-info",
            { "exec-approval-info--error": Boolean(props.lastError) },
          ]}
          class="exec-approval-details"
          placement="top-end"
          positionAnchor={props.positionAnchor}
        >
          <div class="exec-approval-meta">
            <ExecApprovalHostDetails
              request={props.request}
              nodeDisplayName={props.nodeDisplayName}
            />
            <ExecApprovalDetailRows request={props.request} lastError={props.lastError} />
            {props.variant === "modal"
              ? renderMetaRow(t("execApproval.labels.session"), props.request.sessionKey)
              : undefined}
          </div>
        </Popover>
      </Show>
    </div>
  );
}

export function MobileExecApprovalBody(props: {
  request: ExecApprovalRequestPayload;
  nodeDisplayName?: string;
  lastError?: string;
}) {
  const commandScrollState = useScrollState(true, false);
  let disclosure: HTMLDetailsElement;
  let metadata: HTMLDivElement;
  let animation: Animation | undefined;
  let opening: boolean | undefined;

  function toggle(event: MouseEvent) {
    event.preventDefault();
    const open = !(opening ?? disclosure.open);
    const start = disclosure.getBoundingClientRect().height;
    animation?.cancel();
    animation = undefined;
    opening = undefined;
    disclosure.open = open;
    metadata.inert = !open;
    if (
      event.detail === 0 ||
      disclosure.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const end = disclosure.getBoundingClientRect().height;
    // Keep the expanded content painted during exit; the native disclosure owns
    // the settled state. Reversing starts at its current rendered height.
    disclosure.open = true;
    opening = open;
    animation = disclosure.animate([{ height: `${start}px` }, { height: `${end}px` }], {
      duration: 300,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    });
    animation.onfinish = () => {
      disclosure.open = open;
      opening = undefined;
      animation = undefined;
    };
  }

  onSettled(() => () => animation?.cancel());

  return (
    <>
      <details class="exec-approval-mobile-disclosure" ref={(element) => (disclosure = element)}>
        <summary
          class={[
            "exec-approval-mobile-summary",
            { "exec-approval-mobile-summary--error": Boolean(props.lastError) },
          ]}
          onClick={toggle}
        >
          <Icon name="terminal" class="exec-approval-mobile-terminal" />
          <ExecApprovalCommand request={props.request} scrollState={commandScrollState} />
          <Icon name="chevronDown" class="exec-approval-mobile-chevron" />
        </summary>
        <div class="exec-approval-mobile-metadata" ref={(element) => (metadata = element)}>
          <Show
            when={
              props.lastError ||
              props.request.host ||
              props.request.cwd ||
              props.request.resolvedPath ||
              props.request.security ||
              props.request.scope?.kind === "standing-grant" ||
              props.request.ask
            }
          >
            <div class="exec-approval-meta">
              <div class="exec-approval-mobile-host">
                <ExecApprovalHostDetails
                  request={props.request}
                  nodeDisplayName={props.nodeDisplayName}
                />
              </div>
              {renderMetaRow(t("execApproval.labels.directory"), props.request.cwd, { path: true })}
              <ExecApprovalDetailRows request={props.request} lastError={props.lastError} />
            </div>
          </Show>
        </div>
      </details>
    </>
  );
}

export function renderPluginBody(active: ExecApprovalRequest, variant: "inline" | "modal") {
  return (
    <>
      {" "}
      {active.pluginDescription ? (
        <pre class="exec-approval-command mono">{active.pluginDescription}</pre>
      ) : undefined}
      {active.pluginDetail ? (
        <pre class="exec-approval-command mono" dir="ltr">
          {active.pluginDetail}
        </pre>
      ) : undefined}
      {variant === "modal" && active.request.sessionKey
        ? renderDetails(renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey))
        : undefined}
    </>
  );
}
