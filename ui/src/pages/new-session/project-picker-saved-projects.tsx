import { createSignal, Show } from "solid-js";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
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

export function createSavedProjectManagement(props: ProjectChipProps) {
  const [managing, setManaging] = createSignal(false);
  const [removing, setRemoving] = createSignal(false);
  const [removeError, setRemoveError] = createSignal<string | undefined>(undefined);
  const canManage = () =>
    canCallGatewayMethod(
      props.params.context?.gateway.snapshot,
      "projects.remove",
      "operator.admin",
    );
  const removeSavedProject = async (project: ProjectRecord) => {
    const gateway = props.params.context?.gateway;
    const draftGateway = props.params.gateway;
    const browser = props.params.place.browser;
    if (!gateway || project.source === "workspace" || !canManage() || removing()) {
      return;
    }
    const client = gateway.snapshot.client;
    const epoch = draftGateway.connectionEpoch;
    if (!client) {
      return;
    }
    const isCurrent = () =>
      props.params.context?.gateway === gateway &&
      props.params.gateway === draftGateway &&
      props.params.place.browser === browser &&
      gateway.snapshot.client === client &&
      draftGateway.connectionEpoch === epoch;
    setRemoveError(undefined);
    try {
      const confirmed = await showConfirmDialog({
        title: t("newSession.removeSavedProjectTitle", { name: project.displayName }),
        message: t("newSession.removeSavedProjectImpact"),
        details: project.repoRoot ?? project.repositoryIdentity ?? project.id,
        confirmLabel: t("common.remove"),
        danger: true,
        canConfirm: () => isCurrent() && canManage(),
      });
      if (!confirmed || !isCurrent() || !canManage() || removing()) {
        return;
      }
      setRemoving(true);
      await client.request("projects.remove", { id: project.id, deleteCheckout: false });
      if (!isCurrent()) {
        return;
      }
      await browser.refreshProjects(true);
    } catch (error) {
      if (isCurrent()) {
        setRemoveError(formatUiError(error));
      }
    } finally {
      setRemoving(false);
    }
  };
  return {
    managing,
    removing,
    removeError,
    canManage,
    removeSavedProject,
    toggle(this: void) {
      setManaging(!managing());
      setRemoveError(undefined);
    },
  };
}

export function SavedProjectRow(props: {
  picker: ProjectChipProps;
  project: ProjectRecord;
  suffix?: string;
  management: ReturnType<typeof createSavedProjectManagement>;
}) {
  const icon = (
    <ProjectRowIcon context={props.picker.params.context} projectId={props.project.id} />
  );
  const remove = () =>
    props.management.managing() &&
    props.management.canManage() &&
    props.project.source !== "workspace";
  const sub = () =>
    [props.project.repositoryIdentity, props.suffix].filter(Boolean).join(" · ") ||
    (props.project.source === "workspace"
      ? t("newSession.folderPlaceholder")
      : props.project.repoRoot);
  return (
    <SessionMenuItem
      item={{
        value: `project:${props.project.id}`,
        label: remove()
          ? t("newSession.removeSavedProjectLabel", {
              name: props.project.displayName,
            })
          : props.project.displayName,
        icon,
        sub: sub(),
        checked: !remove() && props.picker.params.place.browser.projectId === props.project.id,
        keepOpen: remove(),
        title: remove() ? t("newSession.removeSavedProjectHint") : sub(),
        onSelect: () =>
          remove()
            ? void props.management.removeSavedProject(props.project)
            : props.picker.params.place.selectProjectId(props.project.id),
      }}
      submitting={
        props.picker.params.submitting ||
        props.management.removing() ||
        (props.management.managing() && !remove())
      }
    />
  );
}
