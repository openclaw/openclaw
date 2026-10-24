import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading, Show } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SkillsProps } from "./view-types.ts";

export function MarkdownContent(props: {
  content: string;
  changelog?: boolean;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
}) {
  return (
    <SanitizedHtml
      tag="article"
      class={["lit-content", props.class]}
      style={props.style}
      onClick={props.onClick}
      html={toSanitizedMarkdownHtml(
        props.content,
        props.changelog ? { codeBlockChrome: "none", mode: "document" } : undefined,
      )}
    />
  );
}

export function SkillReaderDialog(props: {
  label: string;
  onClose: () => void;
  title: JSX.Element;
  footer?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <openclaw-modal-dialog
      label={props.label}
      style={{ "--openclaw-modal-width": "min(1040px, calc(100vw - 32px))" }}
      onModal-cancel={() => props.onClose()}
    >
      <div class="exec-approval-card skill-reader-dialog">
        <div class="exec-approval-header">
          {props.title}
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t("skillsPage.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
        {props.children}
        {props.footer}
      </div>
    </openclaw-modal-dialog>
  );
}

export function ClawHubDetailDialog(props: { view: SkillsProps; installLocked: boolean }) {
  const reference = createMemo(() => props.view.state.clawhubDetailRef);
  const detail = createMemo(() => props.view.readClawHubDetail());
  const skillIconUrl = () => {
    const icon = detail()?.skill?.icon;
    return icon ? props.view.state.clawhubIconUrls?.[icon] : undefined;
  };
  const profileImageUrl = () => {
    const image = detail()?.owner?.image;
    return skillIconUrl() || !image ? undefined : props.view.state.clawhubIconUrls?.[image];
  };
  const detailImageUrl = () => skillIconUrl() ?? profileImageUrl();
  const pendingTitle = () => <div class="exec-approval-title">{reference()}</div>;
  return (
    <SkillReaderDialog
      label={
        // The shell remains openable while its async content is pending.
        props.view.state.clawhubDetail?.skill?.displayName ??
        reference() ??
        t("skillsPage.notFound")
      }
      onClose={() => props.view.onClawHubDetailClose()}
      title={
        <div class="clawhub-skill-detail__identity">
          <Errored fallback={pendingTitle}>
            <Loading on={reference()} fallback={pendingTitle()}>
              <Show when={detailImageUrl()}>
                {(url) => (
                  <img
                    class={[
                      "clawhub-skill-icon clawhub-skill-icon--detail",
                      { "clawhub-skill-icon--profile": Boolean(profileImageUrl()) },
                    ]}
                    src={url()}
                    alt=""
                  />
                )}
              </Show>
              <div class="exec-approval-title">{detail()?.skill?.displayName ?? reference()}</div>
            </Loading>
          </Errored>
        </div>
      }
      footer={
        <Errored fallback={() => null}>
          <Loading on={reference()}>
            <Show when={detail()?.skill}>
              {(skill) => (
                <openclaw-modal-actions class="exec-approval-actions skill-reader-dialog__actions">
                  <button
                    class="btn primary"
                    disabled={props.installLocked}
                    onClick={() => {
                      const ref = reference();
                      if (ref) {
                        props.view.onClawHubInstall(ref);
                      }
                    }}
                  >
                    {props.view.state.skillOperation?.kind === "clawhub" &&
                    props.view.state.skillOperation.ref === (reference() ?? "")
                      ? t("skillsPage.installing")
                      : props.view.showInventory === false
                        ? t("skillLibrary.import")
                        : t("skillsPage.installNamed", { name: skill().displayName })}
                  </button>
                </openclaw-modal-actions>
              )}
            </Show>
          </Loading>
        </Errored>
      }
    >
      <div class="skill-reader-dialog__body clawhub-skill-detail__body">
        <Errored
          fallback={(error) => (
            <div class="callout danger skill-reader-dialog__error" role="alert">
              <span aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <span>{formatUiError(error())}</span>
            </div>
          )}
        >
          <Loading
            on={reference()}
            fallback={
              <div class="muted" role="status">
                {t("common.loading")}
              </div>
            }
          >
            <Show
              when={detail()?.skill}
              fallback={
                <div class="muted" role="status">
                  {t("skillsPage.notFound")}
                </div>
              }
            >
              {(skill) => (
                <>
                  <div>{skill().summary ?? ""}</div>{" "}
                  <Show when={detail()?.owner?.displayName || detail()?.latestVersion}>
                    <div
                      class="clawhub-skill-detail__meta muted"
                      style={{ "letter-spacing": "normal" }}
                    >
                      <Show when={detail()?.owner?.displayName}>
                        {t("skillsPage.by")} {detail()?.owner?.displayName}
                        <Show when={detail()?.owner?.handle}> (@{detail()?.owner?.handle})</Show>
                      </Show>
                      {detail()?.owner?.displayName && detail()?.latestVersion ? " · " : undefined}
                      <Show when={detail()?.latestVersion}>
                        {(version) => <>{t("skillsPage.latest", { version: version().version })}</>}
                      </Show>
                    </div>
                  </Show>{" "}
                  <Show when={detail()?.latestVersion?.changelog}>
                    {(changelog) => (
                      <MarkdownContent
                        class="clawhub-skill-detail__changelog sidebar-markdown"
                        content={changelog()}
                        changelog
                      />
                    )}
                  </Show>{" "}
                  <Show when={detail()?.metadata?.os}>
                    {(os) => (
                      <div class="clawhub-skill-detail__meta muted">
                        {t("skillsPage.platforms", { platforms: os().join(", ") })}
                      </div>
                    )}
                  </Show>{" "}
                </>
              )}
            </Show>
          </Loading>
        </Errored>
      </div>
    </SkillReaderDialog>
  );
}
