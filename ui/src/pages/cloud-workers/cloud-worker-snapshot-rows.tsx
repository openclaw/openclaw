import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, type Accessor } from "solid-js";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import {
  SettingsEmpty,
  SettingsSection,
  SettingsSummary,
  SettingsRow,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type SnapshotImage = {
  profileKey: string;
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  projectKey?: string;
  projectLabel?: string;
  projectRoot?: string;
  checkpointId?: string;
  state: "pending" | "available" | "no-image";
  createdAtMs?: number;
  lastDemandAtMs?: number | null;
  baseCommit?: string;
  runtimeIdentity?: { nodeBootstrapSha256: string };
  pinned?: { atMs: number };
  previous?: {
    checkpointId: string;
    createdAtMs: number;
    baseCommit?: string;
    runtimeIdentity?: { nodeBootstrapSha256: string };
    pinned?: { atMs: number };
  };
  held: boolean;
  allocationCount: number;
  retirement?: { checkpointId: string };
  capture?: {
    selector: string;
    leaseId?: string;
    phase: "scrubbing" | "creating" | "uncertain";
    stale: boolean;
  };
  captureUnsupported?: { atMs: number; provider: string; message: string };
};
export type SnapshotProfile = {
  id: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  warmImages: "on" | "off";
  reason: string;
};
export type SnapshotsResult = {
  images: SnapshotImage[];
  profiles: SnapshotProfile[];
  legacyLeases: { leaseId: string; selector: string; recoveryHint: string }[];
};

type SnapshotRowOptions = {
  showMachineFacts: boolean;
  busy: boolean;
  buildBusy: boolean;
  deleteReason: string | null;
  onPin?: (previous: boolean) => void;
  onRollback?: () => void;
  onDelete?: () => void;
  onRecover?: () => void;
  onRebuild?: () => void;
};

function ImageAction(props: {
  action: "pin" | "unpin" | "rollback" | "delete" | "rebuild" | "recover";
  target: string | undefined;
  onClick: (() => void) | undefined;
  disabled: boolean;
  title?: string;
}) {
  const label = () => t(`cloudWorkersPage.snapshots.${props.action}`);
  return (
    <Show when={props.onClick}>
      <button
        class={props.action === "delete" ? "btn btn--sm danger" : "btn btn--sm"}
        type="button"
        aria-label={`${label()}: ${props.target}`}
        title={props.title}
        disabled={props.disabled}
        onClick={() => props.onClick?.()}
      >
        {label()}
      </button>
    </Show>
  );
}

export function SnapshotImageRow(props: SnapshotRowOptions & { image: SnapshotImage }) {
  const image = () => props.image;
  const changeReason = () =>
    image().capture || image().retirement
      ? t("cloudWorkersPage.snapshots.captureOrRetirement")
      : "";
  const phase = () => image().capture?.phase;
  const retiringCurrentImage = () =>
    Boolean(image().retirement && image().retirement?.checkpointId === image().checkpointId);
  const imageState = () =>
    phase() ??
    (retiringCurrentImage()
      ? "retiring"
      : image().state === "no-image"
        ? image().captureUnsupported
          ? "coldOnly"
          : "noImage"
        : image().state);
  const facts = createMemo(() => {
    const current = image();
    const runtimeDigest = current.runtimeIdentity?.nodeBootstrapSha256.slice(0, 12);
    return [
      ...(props.showMachineFacts ? [current.backend, current.machineClass, current.os] : []),
      current.baseCommit &&
        t("cloudWorkersPage.snapshots.baseCommit", { commit: current.baseCommit.slice(0, 8) }),
      current.createdAtMs != null &&
        t("cloudWorkersPage.snapshots.created", {
          age: formatRelativeTimestamp(current.createdAtMs),
        }),
      current.lastDemandAtMs != null &&
        t("cloudWorkersPage.snapshots.lastUsed", {
          age: formatRelativeTimestamp(current.lastDemandAtMs),
        }),
      t("cloudWorkersPage.snapshots.allocations", { count: String(current.allocationCount) }),
      runtimeDigest && t("cloudWorkersPage.snapshots.runtime", { digest: runtimeDigest }),
    ]
      .filter(Boolean)
      .join(" · ");
  });
  function PinAction(pinProps: { previous?: boolean }) {
    const checkpoint = () => (pinProps.previous ? image().previous : image());
    return (
      <Show when={Boolean(checkpoint()?.checkpointId && props.onPin)}>
        <ImageAction
          action={checkpoint()?.pinned ? "unpin" : "pin"}
          target={checkpoint()?.checkpointId}
          onClick={() => props.onPin?.(Boolean(pinProps.previous))}
          disabled={Boolean(changeReason()) || props.busy}
          title={changeReason()}
        />
      </Show>
    );
  }
  return (
    <SettingsRow
      title={
        image().projectKey
          ? (image().projectLabel ?? t("cloudWorkersPage.snapshots.projectImage"))
          : t("cloudWorkersPage.snapshots.machineImage")
      }
      description={
        <>
          {facts()}
          <Show when={image().captureUnsupported}>
            {(unsupported) => (
              <div>
                {unsupported().message.replace(/[.\s]+$/u, "")}.{" "}
                {t("cloudWorkersPage.snapshots.captureUnsupportedHint")}
              </div>
            )}
          </Show>
          <Show when={image().previous}>
            {(previous) => (
              <div>
                {t("cloudWorkersPage.snapshots.previous")}: <code>{previous().checkpointId}</code>{" "}
                {t("cloudWorkersPage.snapshots.created", {
                  age: formatRelativeTimestamp(previous().createdAtMs),
                })}{" "}
                <Show when={previous().baseCommit}>
                  {(commit) => (
                    <>
                      {t("cloudWorkersPage.snapshots.baseCommit", { commit: commit().slice(0, 8) })}
                    </>
                  )}
                </Show>{" "}
                <Show when={previous().pinned}>
                  <SettingsStatus kind="accent" label={t("cloudWorkersPage.snapshots.pinned")} />
                </Show>
                <PinAction previous />
                <ImageAction
                  action="rollback"
                  target={previous().checkpointId}
                  onClick={props.onRollback}
                  disabled={Boolean(image().capture || image().retirement) || props.busy}
                  title={changeReason()}
                />
              </div>
            )}
          </Show>
          <Show when={image().retirement}>
            {(retirement) => (
              <>
                <br />
                {t("cloudWorkersPage.snapshots.retirementHint", {
                  checkpoint: retirement().checkpointId,
                })}
              </>
            )}
          </Show>
        </>
      }
      stackedOnNarrow
      control={
        <>
          <SettingsStatus
            kind={
              phase() === "uncertain" || retiringCurrentImage()
                ? "warn"
                : phase()
                  ? "accent"
                  : image().state === "available"
                    ? "ok"
                    : "muted"
            }
            label={t(`cloudWorkersPage.snapshots.${imageState()}`)}
          />
          <Show when={image().pinned}>
            <SettingsStatus kind="accent" label={t("cloudWorkersPage.snapshots.pinned")} />
          </Show>
          <PinAction />
          <ImageAction
            action="delete"
            target={image().checkpointId}
            onClick={image().checkpointId ? props.onDelete : undefined}
            disabled={Boolean(props.deleteReason) || props.busy}
            title={props.deleteReason ?? ""}
          />
          <Show when={image().retirement}>
            <SettingsStatus kind="warn" label={t("cloudWorkersPage.snapshots.retirementPending")} />
          </Show>
          <ImageAction
            action="rebuild"
            target={
              image().projectLabel ??
              image().projectRoot ??
              image().projectKey ??
              image().profileId ??
              image().profileKey
            }
            onClick={props.onRebuild}
            disabled={props.buildBusy}
          />
          <ImageAction
            action="recover"
            target={image().capture?.selector}
            onClick={phase() === "uncertain" ? props.onRecover : undefined}
            disabled={props.busy}
          />
        </>
      }
    />
  );
}

export function SnapshotBuildRow(props: {
  environment: EnvironmentSummary;
  busy: boolean;
  onCancel?: () => void;
  onDismiss?: () => void;
}) {
  const worker = () => props.environment.worker;
  const failed = () => worker()?.state === "failed" || worker()?.state === "orphaned";
  const action = () => (failed() ? props.onDismiss : props.onCancel);
  const actionLabel = () => t(failed() ? "cloudWorkersPage.snapshots.dismiss" : "common.cancel");
  return (
    <Show when={worker()}>
      {(currentWorker) => (
        <SettingsRow
          title={t(
            failed()
              ? `cloudWorkersPage.snapshots.buildStates.${currentWorker().state}`
              : "cloudWorkersPage.snapshots.building",
          )}
          description={
            <>
              {props.environment.id} ·{" "}
              {t(`cloudWorkersPage.snapshots.buildStates.${currentWorker().state}`)} ·{" "}
              {t("cloudWorkersPage.snapshots.buildAge", {
                age: formatDurationHuman(currentWorker().ageMs),
              })}
              <Show when={failed() && currentWorker().error}>
                <div class="callout warning" role="alert">
                  {currentWorker().error}
                </div>
              </Show>
            </>
          }
          control={
            <Show when={action()}>
              <button
                class="btn btn--sm"
                type="button"
                aria-label={`${actionLabel()}: ${props.environment.id}`}
                disabled={props.busy}
                onClick={() => action()?.()}
              >
                {actionLabel()}
              </button>
            </Show>
          }
        />
      )}
    </Show>
  );
}

type SnapshotGroup = {
  profile?: SnapshotProfile;
  images: SnapshotImage[];
  builds: EnvironmentSummary[];
};
export function SnapshotInventory(props: {
  result: SnapshotsResult | null;
  builds: EnvironmentSummary[];
  failedBuilds: EnvironmentSummary[];
  buildRow: (environment: Accessor<EnvironmentSummary>) => JSX.Element;
  imageRow: (image: Accessor<SnapshotImage>, showMachineFacts: Accessor<boolean>) => JSX.Element;
}) {
  const groups = createMemo(() => {
    const grouped = new Map<string | undefined, SnapshotGroup>(
      (props.result?.profiles ?? []).map((profile) => [
        profile.id,
        { profile, images: [], builds: [] },
      ]),
    );
    for (const image of props.result?.images ?? []) {
      const group = grouped.get(image.profileId) ?? { images: [], builds: [] };
      group.images.push(image);
      grouped.set(image.profileId, group);
    }
    for (const environment of [...props.builds, ...props.failedBuilds]) {
      const profileId = environment.worker?.profileId;
      const group = grouped.get(profileId) ?? { images: [], builds: [] };
      group.builds.push(environment);
      grouped.set(profileId, group);
    }
    return [...grouped];
  });
  const buildLeases = createMemo(
    () =>
      new Set(
        props.builds.flatMap((environment) =>
          environment.worker?.leaseId ? [environment.worker.leaseId] : [],
        ),
      ),
  );
  return (
    <>
      <Show when={props.result}>
        {(result) => (
          <SettingsSummary
            items={[
              {
                label: t("cloudWorkersPage.snapshots.images"),
                value: result().images.filter((image) => image.checkpointId).length,
              },
              {
                label: t("cloudWorkersPage.snapshots.building"),
                value:
                  props.builds.length +
                  result().images.filter(
                    (image) =>
                      image.capture &&
                      image.capture.phase !== "uncertain" &&
                      (!image.capture.leaseId || !buildLeases().has(image.capture.leaseId)),
                  ).length,
              },
              {
                label: t("cloudWorkersPage.snapshots.held"),
                value: result().images.filter((image) => image.held).length,
              },
              {
                label: t("cloudWorkersPage.snapshots.attention"),
                value:
                  props.failedBuilds.length +
                  result().images.filter(
                    (image) =>
                      image.retirement ||
                      image.capture?.phase === "uncertain" ||
                      image.capture?.stale,
                  ).length,
              },
            ]}
          />
        )}
      </Show>
      <For
        each={groups()}
        keyed={(entry) => entry[0]}
        fallback={<SettingsEmpty message={t("cloudWorkersPage.snapshots.empty")} />}
      >
        {(entry) => {
          const group = () => entry()[1];
          const metadata = createMemo(() =>
            (["backend", "machineClass", "os"] as const).map((key) => {
              const values = Array.from(
                new Set(
                  group()
                    .images.map((image) => image[key])
                    .filter(Boolean),
                ),
              );
              const configured = group().profile?.[key];
              return values.length ? values : configured ? [configured] : [];
            }),
          );
          const facts = createMemo(() => {
            const values = metadata()
              .map((entries) => entries.join(", "))
              .filter(Boolean);
            const profile = group().profile;
            if (profile) {
              values.push(
                t(
                  profile.warmImages === "on"
                    ? "cloudWorkersPage.snapshots.warmOn"
                    : "cloudWorkersPage.snapshots.warmOff",
                ),
                profile.reason,
              );
            }
            return values.join(" · ");
          });
          const mixedMetadata = () => metadata().some((values) => values.length > 1);
          return (
            <SettingsSection
              title={entry()[0] ?? t("cloudWorkersPage.snapshots.unlabeledProfile")}
              description={facts()}
              count={group().images.length + group().builds.length}
            >
              <Show
                when={group().images.length || group().builds.length}
                fallback={<SettingsEmpty message={t("cloudWorkersPage.snapshots.profileEmpty")} />}
              >
                <For each={group().builds} keyed={(environment) => environment.id}>
                  {(environment) => props.buildRow(environment)}
                </For>
                <For
                  each={group().images}
                  keyed={(image) => JSON.stringify([image.profileKey, image.projectKey])}
                >
                  {(image) => props.imageRow(image, mixedMetadata)}
                </For>
              </Show>
            </SettingsSection>
          );
        }}
      </For>
      <Show when={props.result?.legacyLeases.length}>
        <SettingsSection
          title={t("cloudWorkersPage.snapshots.migration")}
          description={t("cloudWorkersPage.snapshots.migrationHint")}
        >
          <For each={props.result?.legacyLeases ?? []} keyed={(lease) => lease.leaseId}>
            {(lease) => <SettingsRow title={lease().leaseId} description={lease().recoveryHint} />}
          </For>
        </SettingsSection>
      </Show>
    </>
  );
}
