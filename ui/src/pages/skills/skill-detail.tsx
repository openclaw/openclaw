import type { JSX } from "@solidjs/web";
import {
  createMemo,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Match,
  Show,
  Switch,
} from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { computeSkillReasons, isSkillAvailable } from "../../lib/skills-shared.ts";
import {
  skillApiKeyReplaceable,
  storedSkillApiKeySource,
} from "../../lib/skills/api-key-source.ts";
import type { ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { PluginReadmeWell } from "../plugins/detail-shell.tsx";
import { MarkdownContent } from "./skill-markdown.tsx";
import {
  SkillEnabledSwitch,
  SkillLinkFact,
  SkillMonoFact,
  SkillPageSection,
  SkillSecurityFact,
  type SkillSecurityTone,
} from "./skill-page-parts.tsx";
import { SkillPageShell } from "./skill-page-shell.tsx";
import { SkillTile, verdictForSkill, verdictStatus } from "./skill-status.tsx";
import type { SkillsProps } from "./view-types.ts";

type BinRow = { kind: "bin"; names: string[]; missing: boolean; install: boolean };
type FactRow = { kind: "env" | "config" | "os"; name: string; missing: boolean };
type RequirementRow = BinRow | { kind: "key" } | FactRow;

const REQUIREMENT_ICONS = { env: "key", config: "settings", os: "monitor" } as const;
const REQUIREMENT_LABELS = {
  env: "skillsPage.environmentVariable",
  config: "skillsPage.configuration",
  os: "skillsPage.operatingSystem",
} as const;

/**
 * One row per declared requirement. The Gateway's one installer for a missing binary sits on
 * the first row it provides; the API key row replaces the plain row of the env var it names.
 */
function requirementRows(skill: SkillStatusEntry, installBins: readonly string[]) {
  const rows: RequirementRow[] = [];
  // A missing item is a requirement even when the declared list does not repeat it.
  const declared = (key: keyof SkillStatusEntry["requirements"]) => [
    ...new Set([...skill.requirements[key], ...skill.missing[key]]),
  ];
  let installPlaced = false;
  const placeInstall = (names: string[], missing: boolean) => {
    const install = !installPlaced && missing && names.some((name) => installBins.includes(name));
    installPlaced ||= install;
    return install;
  };
  for (const bin of declared("bins")) {
    const missing = skill.missing.bins.includes(bin);
    rows.push({ kind: "bin", names: [bin], missing, install: placeInstall([bin], missing) });
  }
  if (declared("anyBins").length > 0) {
    const names = declared("anyBins");
    const missing = skill.missing.anyBins.length > 0;
    rows.push({ kind: "bin", names, missing, install: placeInstall(names, missing) });
  }
  if (skill.primaryEnv) {
    rows.push({ kind: "key" });
  }
  for (const env of declared("env")) {
    if (env !== skill.primaryEnv) {
      rows.push({ kind: "env", name: env, missing: skill.missing.env.includes(env) });
    }
  }
  for (const path of declared("config")) {
    rows.push({ kind: "config", name: path, missing: skill.missing.config.includes(path) });
  }
  if (declared("os").length > 0) {
    rows.push({
      kind: "os",
      name: declared("os").join(", "),
      missing: skill.missing.os.length > 0,
    });
  }
  return rows;
}

function verdictTone(
  verdict: ClawHubSkillSecurityVerdict | null,
  status: Pick<ReturnType<typeof verdictStatus>, "kind">,
): SkillSecurityTone {
  if (status.kind === "ok") {
    return "pass";
  }
  if (status.kind === "muted") {
    return "unknown";
  }
  return verdict?.securityStatus === "malicious"
    ? "danger"
    : verdict?.securityStatus === "suspicious"
      ? "warning"
      : "unknown";
}

export function InstalledSkillPage(props: {
  skill: SkillStatusEntry;
  view: SkillsProps;
  controlsLocked: boolean;
  installLocked: boolean;
}) {
  const updateLocked = createMemo(() => props.controlsLocked || !props.view.canUpdate);
  const active = () =>
    props.view.state.skillOperation?.kind === "skill" &&
    props.view.state.skillOperation.skillKey === props.skill.skillKey;
  const homepageHref = createMemo(() =>
    resolveSafeExternalUrl(props.skill.homepage ?? "", window.location.href),
  );
  const editValue = createMemo(() => props.view.state.skillEdits[props.skill.skillKey] ?? "");
  // Typing over a SecretRef or ${VAR} would store the key as plaintext, as in the Settings forms.
  const keySource = () =>
    storedSkillApiKeySource(props.view.apiKeyConfig.snapshot(), props.skill.skillKey);
  const keyLocked = createMemo(
    () => skillApiKeyReplaceable(props.view.apiKeyConfig.snapshot(), props.skill.skillKey) !== true,
  );
  const keyLoadError = createMemo(() =>
    keySource() === undefined ? props.view.apiKeyConfig.error() : null,
  );
  const keyPlaceholder = createMemo(() => {
    const source = keySource();
    return source?.kind === "environment"
      ? t("skillsPage.apiKeyFromEnvironment", { name: source.name })
      : source?.kind === "reference"
        ? t("skillsPage.apiKeyFromSecretRef")
        : props.skill.primaryEnv;
  });
  const message = () => props.view.state.skillMessages[props.skill.skillKey] ?? null;
  const installOption = createMemo(() => {
    const missingBins = new Set([...props.skill.missing.bins, ...props.skill.missing.anyBins]);
    // An installer must provide a currently missing binary, not an unrelated dependency.
    return props.skill.install.find((option) => option.bins.some((bin) => missingBins.has(bin)));
  });
  const rows = createMemo(() => requirementRows(props.skill, installOption()?.bins ?? []));
  const reasons = createMemo(() => computeSkillReasons(props.skill));
  const verdict = createMemo(() => verdictForSkill(props.skill, props.view.state.clawhubVerdicts));
  const available = () => isSkillAvailable(props.skill);
  const linkedOwner = () => {
    const link = props.skill.clawhub;
    return link?.status === "linked" && link.ownerHandle ? `@${link.ownerHandle}` : null;
  };
  const RequirementState = (state: { missing: boolean }) => (
    <Show
      when={state.missing}
      fallback={
        <span class="skill-requirement__met" role="img" aria-label={t("skillsPage.tabs.ready")}>
          <Icon name="check" />
        </span>
      }
    >
      <SettingsStatus kind="warn" label={t("skillsPage.tabs.needsSetup")} />
    </Show>
  );
  const Requirement = (row: {
    icon: Parameters<typeof Icon>[0]["name"];
    title: JSX.Element;
    mono?: boolean;
    detail: JSX.Element;
    control: JSX.Element;
    wide?: boolean;
  }) => (
    <div class={["skill-requirement", { "skill-requirement--field": row.wide }]}>
      <span class="skill-requirement__tile" aria-hidden="true">
        <Icon name={row.icon} />
      </span>
      <div class="skill-requirement__text">
        <span class={["skill-requirement__title", { "skill-requirement__title--mono": row.mono }]}>
          {row.title}
        </span>
        <span class="skill-requirement__detail">{row.detail}</span>
      </div>
      <div class="skill-requirement__control">{row.control}</div>
    </div>
  );
  return (
    <SkillPageShell
      view={props.view}
      name={props.skill.name}
      icon={<SkillTile class="skill-page__tile" emoji={props.skill.emoji} />}
      identity={
        <>
          <span>{linkedOwner() ?? props.skill.source}</span>
          <Show when={!props.skill.disabled}>
            <SettingsStatus
              kind={available() ? "ok" : "warn"}
              label={t(available() ? "skillsPage.tabs.ready" : "skillsPage.tabs.needsSetup")}
            />
          </Show>
        </>
      }
      actions={<SkillEnabledSwitch skill={props.skill} view={props.view} />}
      notices={
        <>
          <Show when={!props.view.canUpdate}>
            <p class="skill-page__note">{t("skillsPage.updateRequiresAdmin")}</p>
          </Show>
          <Show when={props.skill.clawhub?.status === "invalid" ? props.skill.clawhub : null}>
            {(link) => (
              <InlineAlert tone="danger">
                <div class="skill-page__warning-title">{t("skillsPage.invalidLink")}</div>
                <div>{formatUiExternalText(link().reason)}</div>
              </InlineAlert>
            )}
          </Show>
          <Show when={reasons().length > 0}>
            <p class="skill-page__note">
              {t("skillsPage.reason", { reasons: reasons().join(", ") })}
            </p>
          </Show>
        </>
      }
      summary={props.skill.description || undefined}
      panel={
        <>
          <Show when={rows().length > 0}>
            <SkillPageSection title={t("skillsPage.requirements")}>
              <div class="skill-requirements">
                <For each={rows()}>
                  {(row) => (
                    <Switch>
                      <Match when={row.kind === "bin" ? row : null}>
                        {(bin) => (
                          <Requirement
                            icon="terminal"
                            mono
                            title={bin().names.join(" / ")}
                            detail={t("skillsPage.binary")}
                            control={
                              <Show
                                when={bin().install ? installOption() : null}
                                fallback={<RequirementState missing={bin().missing} />}
                              >
                                {(option) => (
                                  <button
                                    type="button"
                                    class="btn"
                                    disabled={props.installLocked}
                                    onClick={() =>
                                      props.view.onInstall(
                                        props.skill.skillKey,
                                        props.skill.name,
                                        option().id,
                                      )
                                    }
                                  >
                                    {active() ? t("skillsPage.installing") : option().label}
                                  </button>
                                )}
                              </Show>
                            }
                          />
                        )}
                      </Match>
                      <Match when={row.kind === "key"}>
                        <Requirement
                          icon="key"
                          wide
                          title={t("skillsPage.apiKey")}
                          detail={
                            <Show
                              when={homepageHref()}
                              fallback={
                                <span class="skill-requirement__env">{props.skill.primaryEnv}</span>
                              }
                            >
                              {(href) => (
                                <a
                                  class="skill-requirement__link"
                                  href={href()}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <span>{t("skillsPage.getYourKey")}</span>
                                  <Icon name="arrowUpRight" />
                                </a>
                              )}
                            </Show>
                          }
                          control={
                            <div class="skill-requirement__key">
                              <input
                                class="settings-input"
                                type="password"
                                required
                                autocomplete="off"
                                aria-label={`${t("skillsPage.apiKey")} (${props.skill.primaryEnv})`}
                                disabled={updateLocked() || keyLocked()}
                                placeholder={keyPlaceholder()}
                                value={editValue()}
                                onInput={(event) =>
                                  props.view.onEdit(props.skill.skillKey, event.currentTarget.value)
                                }
                              />
                              <button
                                type="button"
                                class="btn primary"
                                disabled={updateLocked() || keyLocked() || !editValue().trim()}
                                onClick={() =>
                                  props.view.onSaveKey(props.skill.skillKey, skillApiKeyReplaceable)
                                }
                              >
                                {t("skillsPage.saveKey")}
                              </button>
                            </div>
                          }
                        />
                      </Match>
                      <Match when={row.kind !== "bin" && row.kind !== "key" ? row : null}>
                        {(fact) => (
                          <Requirement
                            icon={REQUIREMENT_ICONS[fact().kind]}
                            mono
                            title={fact().name}
                            detail={t(REQUIREMENT_LABELS[fact().kind])}
                            control={<RequirementState missing={fact().missing} />}
                          />
                        )}
                      </Match>
                    </Switch>
                  )}
                </For>
              </div>
              <Show when={keyLoadError()}>
                {(error) => (
                  <InlineAlert
                    tone="danger"
                    action={
                      <button
                        type="button"
                        class="btn btn--sm"
                        onClick={() => props.view.apiKeyConfig.retry()}
                      >
                        {t("skillsPage.retry")}
                      </button>
                    }
                  >
                    {t("skillsPage.apiKeyConfigError", { error: formatUiExternalText(error()) })}
                  </InlineAlert>
                )}
              </Show>
            </SkillPageSection>
          </Show>
          <Show when={message()}>
            {(value) => (
              <InlineAlert tone={value().kind === "error" ? "danger" : "success"}>
                {formatUiExternalText(value().message)}
              </InlineAlert>
            )}
          </Show>
          <Show when={props.skill.skillCard?.present}>
            <InstalledSkillCard skill={props.skill} view={props.view} />
          </Show>
        </>
      }
      facts={
        <dl class="plugin-metadata__facts plugin-metadata__facts--rail skill-page__facts">
          <InstalledSecurityFact skill={props.skill} view={props.view} verdict={verdict()} />
          <Show when={props.skill.clawhub?.status === "linked" ? props.skill.clawhub : null}>
            {(link) => (
              <div class="skill-page__fact--wide">
                <dt>{t("skillsPage.package")}</dt>
                <dd>
                  <SkillMonoFact
                    value={`${link().ownerHandle ? `@${link().ownerHandle}/` : ""}${link().slug}@${link().installedVersion}`}
                  />
                </dd>
              </div>
            )}
          </Show>
          <div class="skill-page__fact--wide">
            <dt>{t("skillsPage.source")}</dt>
            <dd class="skill-page__fact-stack">
              <span>
                {props.skill.source}
                <Show when={props.skill.bundled && props.skill.source !== "openclaw-bundled"}>
                  {" · "}
                  {t("skillStatus.bundled")}
                </Show>
              </span>
              <SkillMonoFact value={props.skill.filePath} segments={2} />
            </dd>
          </div>
          <Show when={homepageHref()}>
            {(href) => (
              <div class="skill-page__fact--wide">
                <dt>{t("skillsPage.homepage")}</dt>
                <SkillLinkFact href={href()} />
              </div>
            )}
          </Show>
        </dl>
      }
    />
  );
}

function InstalledSecurityFact(props: {
  skill: SkillStatusEntry;
  view: SkillsProps;
  verdict: ClawHubSkillSecurityVerdict | null;
}) {
  const auditHref = createMemo(() =>
    resolveSafeExternalUrl(props.verdict?.securityAuditUrl ?? "", window.location.href),
  );
  const feedback = () => {
    latest(props.view.readClawHubVerdicts);
    if (props.view.state.clawhubVerdictsError) {
      throw new Error(props.view.state.clawhubVerdictsError);
    }
    return props.verdict?.reasons?.length
      ? formatUiExternalText(props.verdict.reasons.join(", "))
      : null;
  };
  const status = () => {
    latest(props.view.readClawHubVerdicts);
    return props.verdict && isPending(props.view.readClawHubVerdicts)
      ? ({ label: t("skillsPage.refreshing"), kind: "muted" } as const)
      : verdictStatus(props.verdict, isPending(props.view.readClawHubVerdicts));
  };
  const pendingFact = () => (
    <SkillSecurityFact label={verdictStatus(null, true).label} tone="unknown" />
  );
  const note = () => (
    <Errored
      fallback={(error) => (
        <Loading>
          <Show when={!isPending(props.view.readClawHubVerdicts)}>{formatUiError(error())}</Show>
        </Loading>
      )}
    >
      <Loading>{feedback()}</Loading>
    </Errored>
  );
  return (
    <Show when={props.skill.clawhub?.status === "linked"}>
      <Errored
        fallback={() => (
          <Loading fallback={pendingFact()}>
            <SkillSecurityFact
              label={verdictStatus(null, isPending(props.view.readClawHubVerdicts)).label}
              tone="unknown"
              note={note()}
            />
          </Loading>
        )}
      >
        <Loading fallback={pendingFact()}>
          <SkillSecurityFact
            label={status().label}
            tone={verdictTone(props.verdict, status())}
            auditHref={auditHref()}
            note={note()}
          />
        </Loading>
      </Errored>
    </Show>
  );
}

function InstalledSkillCard(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const acceptedContent = createMemo(
    () => props.view.state.skillCardContents[props.skill.skillKey],
  );
  const completion = createMemo(() => props.view.state.skillCardReads[props.skill.skillKey]);
  const read = createMemo(() => {
    const receipt = completion();
    const value = acceptedContent();
    const error = props.view.state.skillCardErrors[props.skill.skillKey] ?? null;
    return receipt?.completion ?? Promise.resolve({ value, error });
  });
  const CardContent = () => {
    const content = createMemo(() => {
      const accepted = acceptedContent();
      if (accepted !== undefined) {
        return accepted;
      }
      const outcome = read();
      if (outcome.error) {
        throw new Error(outcome.error);
      }
      return outcome.value;
    });
    return (
      <Show
        when={content() !== undefined}
        fallback={
          <div class="plugin-catalog-detail__readme-well skill-page__card-pending" role="status">
            <span class="muted">{t("skillsPage.skillCardNotLoaded")}</span>
          </div>
        }
      >
        <PluginReadmeWell>
          <MarkdownContent
            class="sidebar-markdown"
            onClick={handleMarkdownCodeBlockClick}
            content={content() ?? ""}
          />
        </PluginReadmeWell>
      </Show>
    );
  };
  // The page reads the card when it opens; the block keeps the clamped card's height meanwhile.
  return (
    <SkillPageSection title={t("skillsPage.skillCard")}>
      <Loading
        on={acceptedContent() === undefined ? completion() : null}
        fallback={
          <div class="plugin-catalog-detail__readme-well skill-page__card-pending">
            <span class="muted" role="status">
              {t("skillsPage.loadingSkillCard")}
            </span>
          </div>
        }
      >
        <Errored
          fallback={(error) => (
            <div class="plugin-catalog-detail__readme-well skill-page__card-pending">
              <InlineAlert
                tone="danger"
                role="alert"
                action={
                  <button
                    type="button"
                    class="btn btn--sm"
                    onClick={() => props.view.onSkillCardRetry(props.skill.skillKey)}
                  >
                    {t("skillsPage.retry")}
                  </button>
                }
              >
                {formatUiError(error())}
              </InlineAlert>
            </div>
          )}
        >
          <CardContent />
        </Errored>
      </Loading>
    </SkillPageSection>
  );
}
