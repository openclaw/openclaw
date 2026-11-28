import { createSignal, Show } from "solid-js";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../../lib/reactive/observers.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import type { ProjectChipProps } from "./project-chip.tsx";
import { ProjectFolderIcon } from "./project-folder-icon.tsx";
import { ProjectIcon } from "./project-icon.tsx";

function ProjectRowIcon(props: Parameters<typeof ProjectIcon>[0]) {
  const [visible, setVisible] = createSignal(typeof IntersectionObserver === "undefined");
  let glyph!: HTMLSpanElement;
  createIntersectionObserver(
    () => (visible() ? [] : [glyph]),
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
      }
    },
  );
  return (
    <span
      class="project-picker-icon"
      ref={(element) => {
        glyph = element;
      }}
    >
      <Show when={visible()} fallback={<ProjectFolderIcon />}>
        <ProjectIcon context={props.context} projectId={props.projectId} />
      </Show>
    </span>
  );
}

export function SavedProjectRow(props: {
  picker: ProjectChipProps;
  project: ProjectRecord;
  suffix?: string;
}) {
  const icon = (
    <ProjectRowIcon context={props.picker.params.context} projectId={props.project.id} />
  );
  const sub = () =>
    [props.project.repositoryIdentity, props.suffix].filter(Boolean).join(" · ") ||
    (props.project.source === "workspace"
      ? t("newSession.folderPlaceholder")
      : props.project.repoRoot);
  return (
    <SessionMenuItem
      item={{
        value: `project:${props.project.id}`,
        label: props.project.displayName,
        icon,
        sub: sub(),
        checked: props.picker.params.place.browser.projectId === props.project.id,
        title: sub(),
        onSelect: () => props.picker.params.place.selectProjectId(props.project.id),
      }}
      submitting={props.picker.params.submitting}
    />
  );
}
