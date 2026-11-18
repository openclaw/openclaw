import { Errored, lazy, Loading, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { pathDisplayName } from "../../lib/path-display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ProjectBrowserFocus } from "./draft-place-browser.ts";
import { SessionPicker } from "./picker.tsx";
import type { resolveProjectChip } from "./project-chip.ts";
import { ProjectFolderIcon } from "./project-folder-icon.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

const ProjectPickerContent = lazy(() => import("./project-picker-content.tsx"), {
  export: "ProjectPickerContent",
});

const ProjectIcon = lazy(() => import("./project-icon.tsx"), { export: "ProjectIcon" });

export type ProjectChipProps = {
  params: NewSessionPlaceControlsOptions;
  state: ReturnType<typeof resolveProjectChip>;
  nativeTerminal: boolean;
  focus?: ProjectBrowserFocus;
};

export function ProjectChip(props: ProjectChipProps) {
  // A chosen device folder shows its own name; an empty path shows the choice.
  const fallback = () => <ProjectFolderIcon />;
  const label = () => {
    const deviceFolder = props.params.place.deviceFolder;
    if (!deviceFolder) {
      return props.state.label;
    }
    return pathDisplayName(deviceFolder.path.trim()) || t("newSession.deviceFolder");
  };
  return (
    <SessionPicker
      lazy
      kind="project"
      label={`${t("newSession.what")}: ${label()}`}
      value={label()}
      icon={
        <Show
          when={props.params.place.browser.projectId}
          fallback={props.params.place.browser.remoteProject ? <Icon name="github" /> : fallback()}
        >
          <Errored fallback={fallback}>
            <Loading fallback={fallback()}>
              <ProjectIcon
                context={props.params.context}
                projectId={props.params.place.browser.projectId}
              />
            </Loading>
          </Errored>
        </Show>
      }
      triggerAttributes={{ "data-project-id": props.params.place.browser.projectId || undefined }}
      params={props.params}
    >
      <ProjectPickerContent
        params={props.params}
        state={props.state}
        nativeTerminal={props.nativeTerminal}
        focus={props.focus}
      />
    </SessionPicker>
  );
}
