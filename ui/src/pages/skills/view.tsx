import { dynamic } from "@solidjs/web";
import { createMemo, lazy, Show } from "solid-js";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import { SkillDialogBoundary } from "./skill-dialog-boundary.tsx";
import type { SkillsList, SkillsProps } from "./view-types.ts";

registerSkillsBrowserEnglish();
registerSkillLibraryEnglish();

const SkillDetail = lazy(() => import("./skill-detail.tsx"), { export: "SkillDetail" });
const ClawHubDetailDialog = lazy(() => import("./skill-reader-dialog.tsx"), {
  export: "ClawHubDetailDialog",
});

export function skillControlsLocked(view: SkillsProps): boolean {
  return view.saving || view.loading || view.state.skillOperation !== null;
}

function skillInstallLocked(view: SkillsProps): boolean {
  return skillControlsLocked(view) || !view.canInstall;
}

export function Skills(props: SkillsProps & { List: SkillsList }) {
  const List = dynamic(() => props.List);
  const detailSkill = createMemo(() =>
    props.state.skillsDetailKey
      ? (props.mutationSkills.find((skill) => skill.skillKey === props.state.skillsDetailKey) ??
        null)
      : null,
  );
  return (
    <>
      <SettingsPage wide carapace={props.surface === "discovery"}>
        <List {...props} />
      </SettingsPage>
      <Show when={detailSkill()}>
        {(skill) => (
          <SkillDialogBoundary onClose={() => props.onDetailClose()}>
            <SkillDetail
              skill={skill()}
              view={props}
              controlsLocked={skillControlsLocked(props)}
              installLocked={skillInstallLocked(props)}
            />
          </SkillDialogBoundary>
        )}
      </Show>
      <Show when={props.state.clawhubDetailRef}>
        <SkillDialogBoundary onClose={() => props.onClawHubDetailClose()}>
          <ClawHubDetailDialog view={props} installLocked={skillInstallLocked(props)} />
        </SkillDialogBoundary>
      </Show>
    </>
  );
}
