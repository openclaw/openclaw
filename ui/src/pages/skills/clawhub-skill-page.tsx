import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateMs } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginReadmeWell } from "../plugins/detail-shell.tsx";
import { renderPluginOfficialBadge } from "../plugins/plugin-card.tsx";
import { MarkdownContent } from "./skill-markdown.tsx";
import {
  SkillEnabledSwitch,
  SkillPageSection,
  SkillSecurityFact,
  type SkillSecurityTone,
} from "./skill-page-parts.tsx";
import { SkillPageAbsent, SkillPageShell } from "./skill-page-shell.tsx";
import { SkillTile, installedReference } from "./skill-status.tsx";
import type { SkillsProps } from "./view-types.ts";

export function ClawHubSkillPage(props: { view: SkillsProps; installLocked: boolean }) {
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
  // After Add, the refreshed inventory names the new skill by the same registry and reference.
  const addedSkill = createMemo(() => {
    const ref = reference();
    const registry = props.view.state.clawhubDetail?.registry;
    if (!ref || !registry) {
      return null;
    }
    return (
      props.view.mutationSkills.find(
        (skill) =>
          skill.clawhub?.valid &&
          skill.clawhub.registry === registry &&
          installedReference(skill) === ref,
      ) ?? null
    );
  });
  const toggleError = () => {
    const skill = installed() && addedSkill();
    const message = skill ? props.view.state.skillMessages[skill.skillKey] : undefined;
    return message?.kind === "error" ? message.message : null;
  };
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
  const name = () => detail()?.skill?.displayName ?? reference() ?? "";
  // The registry read owns this page's states: loading, its error, and a reference it does not know.
  return (
    <Errored
      fallback={(error) => (
        <SkillPageAbsent
          view={props.view}
          name={reference() ?? ""}
          pending={false}
          message={
            <InlineAlert tone="danger" class="skill-page__error" role="alert">
              <span aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <span>{formatUiError(error())}</span>
            </InlineAlert>
          }
        />
      )}
    >
      <Loading
        on={reference()}
        fallback={<SkillPageAbsent view={props.view} name={reference() ?? ""} pending />}
      >
        <Show
          when={detail()?.skill}
          fallback={<SkillPageAbsent view={props.view} name={reference() ?? ""} pending={false} />}
        >
          {(skill) => (
            <SkillPageShell
              view={props.view}
              name={name()}
              icon={
                <SkillTile
                  class={[
                    "skill-page__tile",
                    { "skill-tile--profile": Boolean(profileImageUrl()) },
                  ]}
                  imageUrl={detailImageUrl()}
                />
              }
              identity={
                <Show when={skill().isOfficial || detail()?.owner}>
                  <Show when={skill().isOfficial}>{renderPluginOfficialBadge()}</Show>
                  <Show when={detail()?.owner}>
                    {(owner) => (
                      <>
                        <Show when={owner().displayName}>
                          {(value) => <strong>{value()}</strong>}
                        </Show>
                        <Show when={owner().handle}>{(handle) => <span>@{handle()}</span>}</Show>
                      </>
                    )}
                  </Show>
                </Show>
              }
              actions={
                <Show
                  when={installed() ? addedSkill() : null}
                  fallback={
                    <button
                      class={["btn oc-action skill-page__cta", { primary: !installed() }]}
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
                  }
                >
                  {(added) => <SkillEnabledSwitch skill={added()} view={props.view} />}
                </Show>
              }
              notices={
                <>
                  <Show when={installResult()}>
                    {(result) => (
                      <InlineAlert
                        tone={result().kind === "error" ? "danger" : "success"}
                        tabindex={0}
                        class="skill-page__notice"
                      >
                        {result().text}
                      </InlineAlert>
                    )}
                  </Show>
                  <Show when={toggleError()}>
                    {(error) => (
                      <InlineAlert tone="danger" role="alert" class="skill-page__notice">
                        {formatUiExternalText(error())}
                      </InlineAlert>
                    )}
                  </Show>
                </>
              }
              summary={skill().summary || undefined}
              panel={
                <>
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
                </>
              }
              facts={
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
                          <For each={os()}>
                            {(platform) => <span class="chip">{platform}</span>}
                          </For>
                        </dd>
                      </div>
                    )}
                  </Show>
                </dl>
              }
            />
          )}
        </Show>
      </Loading>
    </Errored>
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
