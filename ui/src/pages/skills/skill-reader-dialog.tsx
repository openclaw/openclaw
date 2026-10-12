import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.ts";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
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
      </div>
    </openclaw-modal-dialog>
  );
}

export function ClawHubDetailDialog(props: { view: SkillsProps; installLocked: boolean }) {
  const detail = createMemo(() => props.view.state.clawhubDetail);
  const skillIconUrl = createMemo(() => {
    const icon = detail()?.skill?.icon;
    return icon ? props.view.state.clawhubIconUrls?.[icon] : undefined;
  });
  const profileImageUrl = createMemo(() => {
    const image = detail()?.owner?.image;
    return skillIconUrl() || !image ? undefined : props.view.state.clawhubIconUrls?.[image];
  });
  const detailImageUrl = createMemo(() => skillIconUrl() ?? profileImageUrl());
  return (
    <SkillReaderDialog
      label={
        detail()?.skill?.displayName ??
        props.view.state.clawhubDetailRef ??
        t("skillsPage.notFound")
      }
      onClose={() => props.view.onClawHubDetailClose()}
      title={
        <div class="clawhub-skill-detail__identity">
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
          <div class="exec-approval-title">
            {detail()?.skill?.displayName ?? props.view.state.clawhubDetailRef}
          </div>
        </div>
      }
    >
      <div class="skill-reader-dialog__body clawhub-skill-detail__body">
        <Show
          when={!props.view.state.clawhubDetailLoading}
          fallback={
            <div class="muted" role="status">
              {t("common.loading")}
            </div>
          }
        >
          <Show
            when={!props.view.state.clawhubDetailError}
            fallback={
              <div class="callout danger skill-reader-dialog__error" role="alert">
                <span aria-hidden="true">
                  <Icon name="alertTriangle" />
                </span>
                <span>{props.view.state.clawhubDetailError}</span>
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
                        {(version) => t("skillsPage.latest", { version: version().version })}
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
                  <div class="exec-approval-actions" style={{ "margin-top": "0" }}>
                    <button
                      class="btn primary"
                      disabled={props.installLocked}
                      onClick={() => {
                        const ref = props.view.state.clawhubDetailRef;
                        if (ref) {
                          props.view.onClawHubInstall(ref);
                        }
                      }}
                    >
                      {props.view.state.skillOperation?.kind === "clawhub" &&
                      props.view.state.skillOperation.ref ===
                        (props.view.state.clawhubDetailRef ?? "")
                        ? t("skillsPage.installing")
                        : props.view.showInventory === false
                          ? t("skillLibrary.import")
                          : t("skillsPage.installNamed", { name: skill().displayName })}
                    </button>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </SkillReaderDialog>
  );
}
