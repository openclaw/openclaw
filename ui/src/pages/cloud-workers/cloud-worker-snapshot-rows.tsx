import { createMemo, For, Show } from "solid-js";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import { Menu, type MenuItem } from "../../components/solid/menu.tsx";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  environmentImage,
  preparationNeedsAttention,
  showPreparationRow,
  snapshotState,
  type CloudEnvironment,
  type SnapshotImage,
  type SnapshotProfile,
} from "./cloud-worker-environment-model.ts";
import { CloudWorkerRepositoryMachine } from "./cloud-worker-repository-machine.tsx";

type SnapshotActions = {
  busy: boolean;
  canCall: (method: string) => boolean;
  deleteReason: (image: SnapshotImage) => string | null;
  onMutate: (
    image: SnapshotImage,
    action: "pin" | "delete" | "rollback",
    previous?: boolean,
  ) => void;
  onRecover: (image: SnapshotImage) => void;
};

function SnapshotMenu(props: SnapshotActions & { image: SnapshotImage }) {
  const menu = createMemo<MenuItem[]>(() => {
    const current = props.image;
    const blocked = props.busy || Boolean(current.capture || current.retirement);
    const items: MenuItem[] = [];
    if (current.checkpointId && props.canCall("crabbox.images.pin")) {
      items.push({
        id: "pin",
        label: t(`cloudWorkersPage.snapshots.${current.pinned ? "unpin" : "pin"}`),
        disabled: blocked,
      });
    }
    if (current.previous && props.canCall("crabbox.images.pin")) {
      items.push({
        id: "pinPrevious",
        label: t(
          current.previous.pinned
            ? "cloudWorkersPage.environments.unpinPrevious"
            : "cloudWorkersPage.environments.pinPrevious",
        ),
        disabled: blocked,
      });
    }
    if (current.previous && props.canCall("crabbox.images.rollback")) {
      items.push({
        id: "rollback",
        label: t("cloudWorkersPage.snapshots.rollback"),
        disabled: blocked,
      });
    }
    if (current.checkpointId && props.canCall("crabbox.images.delete")) {
      items.push({
        id: "delete",
        label: t("common.delete"),
        disabled: props.busy || Boolean(props.deleteReason(current)),
        variant: "danger",
        attributes: { title: props.deleteReason(current) ?? undefined },
      });
    }
    return items;
  });
  return (
    <Show when={menu().length}>
      <Menu
        id={`cloud-environment-actions-${props.image.profileKey}`}
        label={t("cloudWorkersPage.environments.actions")}
        trigger="⋯"
        triggerClass="btn btn--sm"
        items={menu()}
        onSelect={(item) => {
          const current = props.image;
          if (item.id === "pinPrevious") {
            props.onMutate(current, "pin", true);
          } else if (item.id === "pin" || item.id === "delete" || item.id === "rollback") {
            props.onMutate(current, item.id, item.id === "rollback");
          }
        }}
      />
    </Show>
  );
}

export function CloudWorkerSnapshotRow(
  props: SnapshotActions & { image: SnapshotImage; label?: string; actions?: boolean },
) {
  return (
    <div
      class="cloud-environments__snapshot"
      role="group"
      aria-label={props.image.profileId ?? props.image.profileKey}
    >
      <div class="cloud-environments__snapshot-summary">
        <div class="cloud-environments__facts">
          <Show when={props.label}>{(label) => <strong>{label()}</strong>}</Show>
          <span>{t(`cloudWorkersPage.environments.${snapshotState(props.image)}`)}</span>
          <Show when={props.image.baseCommit}>
            {(commit) => <code>{commit().slice(0, 8)}</code>}
          </Show>
          <Show when={props.image.createdAtMs}>
            {(time) => (
              <span>
                {t("cloudWorkersPage.environments.built", { age: formatRelativeTimestamp(time()) })}
              </span>
            )}
          </Show>
          <Show when={props.image.lastDemandAtMs}>
            {(time) => (
              <span>
                {t("cloudWorkersPage.snapshots.lastUsed", { age: formatRelativeTimestamp(time()) })}
              </span>
            )}
          </Show>
        </div>
        <Show when={props.actions}>
          <SnapshotMenu {...props} />
        </Show>
      </div>
      <Show when={props.image.captureUnsupported}>
        {(unsupported) => <p class="muted">{unsupported().message}</p>}
      </Show>
      <Show when={props.image.retirement}>
        {(retirement) => (
          <p class="callout warning" role="status">
            {t("cloudWorkersPage.snapshots.retirementHint", {
              checkpoint: retirement().checkpointId,
            })}
          </p>
        )}
      </Show>
      <Show when={props.image.capture?.phase === "uncertain"}>
        <div class="cloud-environments__recovery">
          <span>{t("cloudWorkersPage.snapshots.uncertain")}</span>
          <button
            class="btn btn--sm"
            type="button"
            disabled={props.busy || !props.canCall("crabbox.images.recover")}
            onClick={() => props.onRecover(props.image)}
          >
            {t("cloudWorkersPage.snapshots.recover")}
          </button>
        </div>
      </Show>
    </div>
  );
}

export function CloudWorkerBuildRow(props: {
  environment: EnvironmentSummary;
  label?: string;
  destroying: boolean;
  canCall: (method: string) => boolean;
  onDestroy: (worker: EnvironmentSummary, dismiss: boolean) => void;
}) {
  const failed = () => props.environment.worker?.state === "failed";
  const orphaned = () => props.environment.worker?.state === "orphaned";
  const stateLabel = () => {
    const worker = props.environment.worker;
    if (worker?.state === "ready" && preparationNeedsAttention(props.environment)) {
      return t("cloudWorkersPage.environments.attention");
    }
    const state =
      worker?.state === "ready" && worker.destroyRequestedAtMs !== undefined
        ? "destroying"
        : worker?.state;
    return t(`cloudWorkersPage.snapshots.buildStates.${state}`);
  };
  return (
    <SettingsRow
      title={`${props.label ? `${props.label} · ` : ""}${stateLabel()}`}
      description={props.environment.worker?.error}
      control={
        <Show when={!orphaned() && props.canCall("environments.destroy")}>
          <button
            class="btn btn--sm"
            type="button"
            disabled={props.destroying}
            aria-label={`${t(failed() ? "cloudWorkersPage.snapshots.dismiss" : "common.cancel")}: ${props.environment.id}`}
            onClick={() => props.onDestroy(props.environment, failed())}
          >
            {t(failed() ? "cloudWorkersPage.snapshots.dismiss" : "common.cancel")}
          </button>
        </Show>
      }
    />
  );
}

export function CloudWorkerEnvironmentSheet(
  props: SnapshotActions & {
    environment: CloudEnvironment;
    profiles: SnapshotProfile[];
    destroying: boolean;
    onRebuild: (profileId: string, root: string) => void;
    onDestroy: (worker: EnvironmentSummary, dismiss: boolean) => void;
  },
) {
  const selectedImage = createMemo(() => environmentImage(props.environment));
  const profileId = () =>
    props.environment.defaultProfile ??
    selectedImage()?.profileId ??
    props.environment.workers[0]?.worker?.profileId;
  const profile = () => props.profiles.find((candidate) => candidate.id === profileId());
  const rebuildReason = () =>
    !selectedImage()?.projectRoot
      ? t("cloudWorkersPage.environments.localOnly")
      : !props.canCall("environments.prepare") || profile()?.warmImages !== "on"
        ? t("cloudWorkersPage.snapshots.invalidProfile")
        : undefined;
  const images = createMemo(() => {
    const defaultProfile = props.environment.defaultProfile;
    return props.environment.images.toSorted(
      (a, b) =>
        Number(b.profileId === defaultProfile) - Number(a.profileId === defaultProfile) ||
        (a.profileId ?? a.profileKey).localeCompare(b.profileId ?? b.profileKey) ||
        (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0),
    );
  });
  const setup = () =>
    props.environment.images
      .toSorted((a, b) => (b.recipePreparationAtMs ?? 0) - (a.recipePreparationAtMs ?? 0))
      .find((candidate) => candidate.recipePreparation)?.recipePreparation;
  const phases = createMemo(() => {
    const durations = setup()?.phaseDurationsMs;
    return (["onCreate", "updateContent", "detectedInstall"] as const).flatMap((name) =>
      durations?.[name] !== undefined ? [{ name, durationMs: durations[name] }] : [],
    );
  });
  const longest = () => Math.max(...phases().map((phase) => phase.durationMs));
  return (
    <section class="cloud-environments__sheet" aria-label={props.environment.label}>
      <header class="cloud-environments__header">
        <h2>{props.environment.label}</h2>
        <div class="cloud-environments__actions">
          <span title={rebuildReason()}>
            <button
              class="btn btn--sm"
              type="button"
              disabled={props.busy || Boolean(rebuildReason())}
              onClick={() => {
                const current = selectedImage();
                const id = profileId();
                if (id && current?.projectRoot) {
                  props.onRebuild(id, current.projectRoot);
                }
              }}
            >
              {t("cloudWorkersPage.snapshots.rebuild")}
            </button>
          </span>
          <Show when={images().length === 1}>
            <For each={images()} keyed={(image) => image.profileKey}>
              {(image) => <SnapshotMenu {...props} image={image()} />}
            </For>
          </Show>
        </div>
      </header>
      <SettingsSection title={t("cloudWorkersPage.environments.snapshot")}>
        <For
          each={images()}
          keyed={(image) => image.profileKey}
          fallback={
            <div class="cloud-environments__facts">
              {t("cloudWorkersPage.environments.coldOnly")}
            </div>
          }
        >
          {(image) => (
            <CloudWorkerSnapshotRow
              {...props}
              image={image()}
              label={images().length > 1 ? (image().profileId ?? image().profileKey) : undefined}
              actions={images().length > 1}
            />
          )}
        </For>
        <For
          each={props.environment.workers.filter(showPreparationRow)}
          keyed={(worker) => worker.id}
        >
          {(worker) => (
            <CloudWorkerBuildRow
              environment={worker()}
              destroying={props.destroying}
              canCall={props.canCall}
              onDestroy={props.onDestroy}
            />
          )}
        </For>
      </SettingsSection>
      <SettingsSection title={t("cloudWorkersPage.environments.setup")}>
        <span
          class="cloud-environments__source"
          title={
            [setup()?.note, setup()?.ignoredPropertiesNote].filter(Boolean).join("\n") || undefined
          }
        >
          {setup()?.source === "script" ? (
            <code>.openclaw/worktree-setup.sh</code>
          ) : setup()?.source === "devcontainer" ? (
            t("cloudWorkersPage.environments.devcontainer")
          ) : setup()?.source === "detected" ? (
            t("cloudWorkersPage.environments.detected")
          ) : (
            "—"
          )}
        </span>
        <Show when={phases().length}>
          <ol class="cloud-environments__steps">
            <For each={phases()}>
              {(phase) => (
                <li
                  class={[
                    "cloud-environments__step",
                    { "cloud-environments__step--longest": phase.durationMs === longest() },
                  ]}
                >
                  <span>{t(`cloudWorkersPage.environments.phases.${phase.name}`)}</span>
                  <span>{formatDurationHuman(phase.durationMs)}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>
        <For each={images()} keyed={(image) => image.profileKey}>
          {(image) => (
            <Show when={image().recipePreparation?.failure}>
              {(failure) => (
                <div class="callout warning" role="alert">
                  <Show when={images().length > 1}>
                    <strong>{image().profileId ?? image().profileKey}</strong>
                  </Show>
                  <p>{failure().reason}</p>
                  <Show when={failure().outputTail}>
                    {(tail) => <pre class="cloud-environments__output">{tail()}</pre>}
                  </Show>
                </div>
              )}
            </Show>
          )}
        </For>
      </SettingsSection>
      <CloudWorkerRepositoryMachine
        repository={props.environment.label}
        profileId={profileId()}
        defaultProfileId={props.environment.defaultProfile}
        machineFacts={[
          selectedImage()?.profileId === profileId()
            ? (selectedImage()?.backend ?? profile()?.backend)
            : profile()?.backend,
          selectedImage()?.profileId === profileId()
            ? (selectedImage()?.machineClass ?? profile()?.machineClass)
            : profile()?.machineClass,
          selectedImage()?.profileId === profileId()
            ? (selectedImage()?.os ?? profile()?.os)
            : profile()?.os,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
    </section>
  );
}
