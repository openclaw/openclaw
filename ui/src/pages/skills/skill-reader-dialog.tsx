import "../../styles/skill-reader-dialog.css";
import "../../styles/sidebar-markdown.css";
import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDateMs } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginReadmeWell } from "../plugins/detail-shell.tsx";
import { renderPluginOfficialBadge } from "../plugins/plugin-card.tsx";
import {
  SkillPageSection,
  SkillSecurityFact,
  SkillTile,
  type SkillSecurityTone,
} from "./skill-page-parts.tsx";
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
  width?: string;
  footer?: JSX.Element;
  /** Skill pages: the identity leads the header and its actions sit before Close. */
  page?: { icon: JSX.Element; byline?: JSX.Element; actions?: JSX.Element };
  children: JSX.Element;
}) {
  return (
    <openclaw-modal-dialog
      label={props.label}
      style={{ "--openclaw-modal-width": `min(${props.width ?? "1040px"}, calc(100vw - 32px))` }}
      onModal-cancel={() => props.onClose()}
    >
      <div class={["oc-dialog skill-reader-dialog", { "skill-page": Boolean(props.page) }]}>
        <div class={["oc-dialog__header", { "skill-page__header": Boolean(props.page) }]}>
          <Show when={props.page} fallback={<h2 class="oc-dialog__title">{props.title}</h2>}>
            {(page) => (
              <>
                {page().icon}
                <div class="skill-page__identity">
                  <h2 class="oc-dialog__title">{props.title}</h2>
                  <Show when={page().byline}>
                    <div class="skill-page__byline">{page().byline}</div>
                  </Show>
                </div>
                <Show when={page().actions}>
                  <div class="skill-page__actions">{page().actions}</div>
                </Show>
              </>
            )}
          </Show>
          <IconButton
            size={28}
            class="oc-dialog__close"
            icon="x"
            label={t("skillsPage.close")}
            tooltip={false}
            onClick={() => props.onClose()}
          />
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
  const installResult = createMemo(() => {
    const result = props.view.state.clawhubInstallMessage;
    return props.view.showInventory !== false && result?.ref === reference() ? result : null;
  });
  const installed = () => installResult()?.kind === "success";
  const adding = () =>
    props.view.state.skillOperation?.kind === "clawhub" &&
    props.view.state.skillOperation.ref === (reference() ?? "");
  const security = createMemo(() => {
    const value = detail()?.security;
    return value?.status === "available" ? value : null;
  });
  const auditHref = createMemo(() =>
    resolveSafeExternalUrl(security()?.virustotalUrl ?? "", window.location.href),
  );
  const cardContent = () => {
    const card = detail()?.card;
    return card?.status === "available" && card.content.trim() ? card.content : null;
  };
  const updated = () => {
    const value = detail()?.skill?.updatedAt;
    return value === undefined ? undefined : formatDateMs(value, { dateStyle: "medium" });
  };
  const pendingTile = () => <SkillTile class="skill-page__tile" />;
  const pendingTitle = () => <span class="exec-approval-title">{reference()}</span>;
  return (
    <SkillReaderDialog
      label={
        // The shell remains openable while its async content is pending.
        props.view.state.clawhubDetail?.skill?.displayName ??
        reference() ??
        t("skillsPage.notFound")
      }
      onClose={() => props.view.onClawHubDetailClose()}
      width="960px"
      page={{
        icon: (
          <Errored fallback={pendingTile}>
            <Loading on={reference()} fallback={pendingTile()}>
              <SkillTile
                class={["skill-page__tile", { "skill-tile--profile": Boolean(profileImageUrl()) }]}
                imageUrl={detailImageUrl()}
              />
            </Loading>
          </Errored>
        ),
        byline: (
          <Errored fallback={() => null}>
            <Loading on={reference()} fallback={null}>
              <Show when={detail()?.owner}>
                {(owner) => (
                  <>
                    <Show when={owner().displayName}>{(name) => <strong>{name()}</strong>}</Show>
                    <Show when={owner().handle}>{(handle) => <span>@{handle()}</span>}</Show>
                  </>
                )}
              </Show>
            </Loading>
          </Errored>
        ),
        actions: (
          <Errored fallback={() => null}>
            <Loading on={reference()} fallback={null}>
              <Show when={detail()?.skill}>
                {(skill) => (
                  <button
                    class={["btn skill-page__cta", { primary: !installed() }]}
                    disabled={props.installLocked || installed()}
                    aria-label={
                      props.view.showInventory === false || adding() || installed()
                        ? undefined
                        : t("skillsPage.addNamed", { name: skill().displayName })
                    }
                    onClick={() => {
                      const ref = reference();
                      if (ref) {
                        props.view.onClawHubInstall(ref);
                      }
                    }}
                  >
                    <Show when={installed()}>
                      <Icon name="check" />
                    </Show>
                    {adding()
                      ? t("skillsPage.adding")
                      : installed()
                        ? t("skillsPage.installed")
                        : props.view.showInventory === false
                          ? t("skillLibrary.import")
                          : t("skillsPage.add")}
                  </button>
                )}
              </Show>
            </Loading>
          </Errored>
        ),
      }}
      title={
        <span class="clawhub-skill-detail__identity">
          <Errored fallback={pendingTitle}>
            <Loading on={reference()} fallback={pendingTitle()}>
              <span class="exec-approval-title">{detail()?.skill?.displayName ?? reference()}</span>
              <Show when={detail()?.skill?.isOfficial}>{renderPluginOfficialBadge()}</Show>
            </Loading>
          </Errored>
        </span>
      }
    >
      <div class="oc-dialog__body skill-reader-dialog__body clawhub-skill-detail__body">
        <Errored
          fallback={(error) => (
            <InlineAlert tone="danger" class="skill-reader-dialog__error" role="alert">
              <span aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <span>{formatUiError(error())}</span>
            </InlineAlert>
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
                <div class="skill-page__columns">
                  <div class="skill-page__main">
                    <Show when={installResult()}>
                      {(result) => (
                        <InlineAlert
                          tone={result().kind === "error" ? "danger" : "success"}
                          tabindex={0}
                          class="skill-reader-dialog__notice"
                        >
                          {result().text}
                        </InlineAlert>
                      )}
                    </Show>
                    <Show when={skill().summary}>
                      {(summary) => <p class="skill-page__lead">{summary()}</p>}
                    </Show>
                    <Show when={cardContent()}>
                      {(content) => (
                        <SkillPageSection title={t("skillsPage.skillCard")}>
                          <PluginReadmeWell>
                            <MarkdownContent class="sidebar-markdown" content={content()} />
                          </PluginReadmeWell>
                        </SkillPageSection>
                      )}
                    </Show>
                    <Show when={detail()?.latestVersion}>
                      {(version) => (
                        <Show when={version().changelog}>
                          {(changelog) => (
                            <SkillPageSection
                              title={t("skillsPage.latest", { version: version().version })}
                            >
                              <MarkdownContent
                                class="clawhub-skill-detail__changelog sidebar-markdown"
                                content={changelog()}
                                changelog
                              />
                            </SkillPageSection>
                          )}
                        </Show>
                      )}
                    </Show>
                  </div>
                  <dl class="plugin-metadata__facts plugin-metadata__facts--rail skill-page__facts">
                    <Show when={security()}>
                      {(value) => (
                        <SkillSecurityFact
                          label={registrySecurityLabel(value().scanStatus)}
                          tone={registrySecurityTone(value().scanStatus)}
                          auditHref={auditHref()}
                        />
                      )}
                    </Show>
                    <Show when={detail()?.latestVersion?.version}>
                      {(version) => (
                        <div>
                          <dt>{t("pluginsPage.version")}</dt>
                          <dd>{version()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={updated()}>
                      {(value) => (
                        <div>
                          <dt>{t("pluginsPage.detailUpdated")}</dt>
                          <dd>{value()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={detail()?.latestVersion?.license}>
                      {(license) => (
                        <div>
                          <dt>{t("skillsPage.license")}</dt>
                          <dd>{license()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={detail()?.metadata?.os?.length ? detail()?.metadata?.os : null}>
                      {(os) => (
                        <div class="plugin-metadata__section">
                          <dt>{t("skillsPage.platformsLabel")}</dt>
                          <dd class="plugin-metadata__categories">
                            <For each={os()}>{(name) => <span class="chip">{name}</span>}</For>
                          </dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                </div>
              )}
            </Show>
          </Loading>
        </Errored>
      </div>
    </SkillReaderDialog>
  );
}

function registrySecurityTone(status: string): SkillSecurityTone {
  if (/^(?:clean|pass|safe|benign)$/iu.test(status)) {
    return "pass";
  }
  if (/^(?:suspicious|warning|review)$/iu.test(status)) {
    return "warning";
  }
  return /^(?:malicious|blocked|fail)$/iu.test(status) ? "danger" : "unknown";
}

function registrySecurityLabel(status: string): string {
  const tone = registrySecurityTone(status);
  if (tone === "pass") {
    return t("skillsPage.verdict.clean");
  }
  if (tone === "warning") {
    return t("skillsPage.verdict.review");
  }
  if (tone === "danger") {
    return t("skillsPage.verdict.blocked");
  }
  return /^(?:pending|not-run)$/iu.test(status) ? t("skillsPage.verdict.pending") : status;
}
