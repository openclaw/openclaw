import { createMemo, Errored, isPending, latest, Loading, Show } from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsStatus, SettingsToggle } from "../../components/solid/settings-ui.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
} from "../../lib/skills-shared.ts";
import type { ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { MarkdownContent, SkillReaderDialog } from "./skill-reader-dialog.tsx";
import { verdictForSkill, verdictStatus } from "./skill-status.tsx";
import type { SkillDetailTab, SkillsProps } from "./view-types.ts";

export function SkillDetail(props: {
  skill: SkillStatusEntry;
  view: SkillsProps;
  controlsLocked: boolean;
  installLocked: boolean;
}) {
  const updateLocked = createMemo(() => props.controlsLocked || !props.view.canUpdate);
  const toggleSaving = () => props.view.toggleSavingSkillKey === props.skill.skillKey;
  const active = () =>
    props.view.state.skillOperation?.kind === "skill" &&
    props.view.state.skillOperation.skillKey === props.skill.skillKey;
  const homepageHref = createMemo(() =>
    resolveSafeExternalUrl(props.skill.homepage ?? "", window.location.href),
  );
  const editValue = createMemo(() => props.view.state.skillEdits[props.skill.skillKey] ?? "");
  const message = () => props.view.state.skillMessages[props.skill.skillKey] ?? null;
  const installOption = createMemo(() => {
    const missingBins = new Set([...props.skill.missing.bins, ...props.skill.missing.anyBins]);
    // An installer must provide a currently missing binary, not an unrelated dependency.
    return props.skill.install.find((option) => option.bins.some((bin) => missingBins.has(bin)));
  });
  const missing = createMemo(() => computeSkillMissing(props.skill));
  const reasons = createMemo(() => computeSkillReasons(props.skill));
  const verdict = createMemo(() => verdictForSkill(props.skill, props.view.state.clawhubVerdicts));
  const detailTab = (): SkillDetailTab =>
    props.view.state.skillsDetailTab === "card" && props.skill.skillCard?.present
      ? "card"
      : "overview";
  const hasTabs = () => Boolean(props.skill.clawhub || props.skill.skillCard?.present);
  return (
    <SkillReaderDialog
      label={props.skill.name}
      onClose={() => props.view.onDetailClose()}
      width="720px"
      title={
        <span class="exec-approval-title">
          <Show when={props.skill.emoji}>{(emoji) => <span>{emoji()}</span>}</Show>
          <span>{props.skill.name}</span>
        </span>
      }
      footer={
        <Show when={installOption() || props.skill.primaryEnv}>
          <openclaw-modal-actions class="oc-dialog__footer skill-reader-dialog__actions">
            <Show when={installOption()}>
              {(option) => (
                <button
                  class="btn"
                  disabled={props.installLocked}
                  onClick={() =>
                    props.view.onInstall(props.skill.skillKey, props.skill.name, option().id)
                  }
                >
                  {active() ? t("skillsPage.installing") : option().label}
                </button>
              )}
            </Show>
            <Show when={props.skill.primaryEnv}>
              <button
                class="btn primary"
                disabled={updateLocked() || !editValue().trim()}
                onClick={() => props.view.onSaveKey(props.skill.skillKey)}
              >
                {t("skillsPage.saveKey")}
              </button>
            </Show>
          </openclaw-modal-actions>
        </Show>
      }
    >
      <div class="oc-dialog__body skill-reader-dialog__body">
        <div class="skill-detail__description">
          <p>{props.skill.description}</p>
          <Show when={!props.skill.primaryEnv && homepageHref()}>
            <a href={homepageHref()!} target="_blank" rel="noopener noreferrer">
              {props.skill.homepage}
            </a>
          </Show>
        </div>
        <Show when={hasTabs()}>
          <HubTabs
            {...{
              id: "skill-detail",
              active: detailTab(),
              tabs: [
                { value: "overview", label: t("skillsPage.overview") },
                ...(props.skill.skillCard?.present
                  ? [{ value: "card" as const, label: t("skillsPage.skillCard") }]
                  : []),
              ],
              ariaLabel: props.skill.name,
              panelId: "skill-detail-panel",
              variant: "sub",
              carapace: true,
              class: "plugins-settings-tabs",
              onSelect: props.view.onDetailTabChange,
            }}
          />
        </Show>
        <div
          id="skill-detail-panel"
          class="skill-detail__panel"
          role={hasTabs() ? "tabpanel" : undefined}
          aria-labelledby={hasTabs() ? `skill-detail-tab-${detailTab()}` : undefined}
        >
          <Show
            when={detailTab() === "overview"}
            fallback={<InstalledSkillCard skill={props.skill} view={props.view} />}
          >
            <InstalledClawHubOverview skill={props.skill} view={props.view} verdict={verdict()} />
          </Show>
        </div>
        <Show when={missing().length > 0}>
          <InlineAlert tone="warning">
            <div class="skill-detail__warning-title">{t("skillsPage.missingRequirements")}</div>
            <div>{missing().join(", ")}</div>
          </InlineAlert>
        </Show>
        <Show when={reasons().length > 0}>
          <div class="skill-detail__note">
            {t("skillsPage.reason", { reasons: reasons().join(", ") })}
          </div>
        </Show>
        <div class="oc-dialog__rows">
          <div class="oc-dialog__row">
            <SettingsStatus
              kind={props.skill.disabled ? "muted" : isSkillAvailable(props.skill) ? "ok" : "warn"}
              label={t(
                props.skill.disabled
                  ? "skillsPage.tabs.disabled"
                  : isSkillAvailable(props.skill)
                    ? "skillsPage.tabs.ready"
                    : "skillsPage.tabs.needsSetup",
              )}
            />
            <SettingsToggle
              checked={!props.skill.disabled}
              saving={toggleSaving()}
              disabled={
                !props.view.canUpdate ||
                (props.view.toggleDisabled ?? props.view.loading) ||
                (!toggleSaving() && props.controlsLocked)
              }
              ariaLabel={props.skill.name}
              onChange={() => props.view.onToggle(props.skill.skillKey, props.skill.disabled)}
            />
          </div>
          <Show when={!props.view.canUpdate}>
            <span class="oc-dialog__row-note">{t("skillsPage.updateRequiresAdmin")}</span>
          </Show>
          <div class="oc-dialog__row">
            <span class="oc-dialog__row-label">{t("skillsPage.source")}</span>
            <span>
              {props.skill.source}
              <Show when={props.skill.bundled && props.skill.source !== "openclaw-bundled"}>
                {" · "}
                {t("skillStatus.bundled")}
              </Show>
            </span>
          </div>
          <span class="oc-dialog__row-note skill-detail__path">{props.skill.filePath}</span>
        </div>
        <Show when={message()}>
          {(value) => (
            <InlineAlert tone={value().kind === "error" ? "danger" : "success"}>
              {formatUiExternalText(value().message)}
            </InlineAlert>
          )}
        </Show>
        <Show when={props.skill.primaryEnv}>
          <div class="skill-detail__key">
            <label class="field">
              <span>
                {t("skillsPage.apiKey")} <span class="muted">({props.skill.primaryEnv})</span>
              </span>
              <input
                type="password"
                required
                disabled={updateLocked()}
                value={editValue()}
                onInput={(event) =>
                  props.view.onEdit(props.skill.skillKey, event.currentTarget.value)
                }
              />
            </label>
            <Show when={homepageHref()}>
              {(href) => (
                <div class="skill-detail__note">
                  {t("skillsPage.getKey")}{" "}
                  <a href={href()} target="_blank" rel="noopener noreferrer">
                    {props.skill.homepage}
                  </a>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </SkillReaderDialog>
  );
}

function InstalledClawHubOverview(props: {
  skill: SkillStatusEntry;
  view: SkillsProps;
  verdict: ClawHubSkillSecurityVerdict | null;
}) {
  const link = () => props.skill.clawhub;
  const invalidReason = () => {
    const value = link();
    return value?.status === "invalid" ? value.reason : null;
  };
  const installedRef = () => {
    const value = link();
    return value?.status === "linked"
      ? `${value.ownerHandle ? `@${value.ownerHandle}/` : ""}${value.slug}@${value.installedVersion}`
      : "";
  };
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
    return verdictStatus(props.verdict, isPending(props.view.readClawHubVerdicts));
  };
  return (
    <Show when={link()}>
      {(current) => (
        <Show
          when={current().status !== "invalid"}
          fallback={
            <InlineAlert tone="danger">
              <div class="skill-detail__warning-title">{t("skillsPage.invalidLink")}</div>
              <div>{formatUiExternalText(invalidReason() ?? "")}</div>
            </InlineAlert>
          }
        >
          <div class="oc-dialog__rows">
            <div class="oc-dialog__row">
              <span class="oc-dialog__row-label">{t("skillsPage.package")}</span>
              <span>{installedRef()}</span>
            </div>
            <div class="oc-dialog__row">
              <span class="oc-dialog__row-label">{t("skillsPage.securityCheck")}</span>
              <Errored
                fallback={() => (
                  <Loading fallback={<SettingsStatus {...verdictStatus(null, true)} />}>
                    <SettingsStatus
                      {...verdictStatus(null, isPending(props.view.readClawHubVerdicts))}
                    />
                  </Loading>
                )}
              >
                <Loading fallback={<SettingsStatus {...verdictStatus(null, true)} />}>
                  <Show
                    when={props.verdict && isPending(props.view.readClawHubVerdicts)}
                    fallback={<SettingsStatus {...status()} />}
                  >
                    <SettingsStatus kind="muted" label={t("skillsPage.refreshing")} />
                  </Show>
                </Loading>
              </Errored>
            </div>
            <Errored
              fallback={(error) => (
                <Loading>
                  <Show when={!isPending(props.view.readClawHubVerdicts)}>
                    <div class="skill-detail__note">{formatUiError(error())}</div>
                  </Show>
                </Loading>
              )}
            >
              <Loading>
                <Show when={feedback()}>
                  {(value) => <div class="skill-detail__note">{value()}</div>}
                </Show>
              </Loading>
            </Errored>
            <Show when={auditHref()}>
              {(href) => (
                <div class="skill-detail__note">
                  <a href={href()} target="_blank" rel="noopener noreferrer">
                    {t("skillsPage.fullSecurityReport")}
                  </a>
                </div>
              )}
            </Show>
          </div>
        </Show>
      )}
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
          <div class="muted" role="status" style={{ "font-size": "13px" }}>
            {t("skillsPage.skillCardNotLoaded")}
          </div>
        }
      >
        <MarkdownContent
          class="sidebar-markdown"
          style={{ "max-width": "100%", "overflow-wrap": "anywhere" }}
          onClick={handleMarkdownCodeBlockClick}
          content={content() ?? ""}
        />
      </Show>
    );
  };
  return (
    <Show when={props.skill.skillCard?.present}>
      <Loading
        on={acceptedContent() === undefined ? completion() : null}
        fallback={
          <div class="muted" role="status" style={{ "font-size": "13px" }}>
            {t("skillsPage.loadingSkillCard")}
          </div>
        }
      >
        <Errored
          fallback={(error) => (
            <InlineAlert tone="danger" role="alert">
              {formatUiError(error())}
            </InlineAlert>
          )}
        >
          <CardContent />
        </Errored>
      </Loading>
    </Show>
  );
}
