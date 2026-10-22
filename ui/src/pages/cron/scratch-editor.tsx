import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  createStore,
  Errored,
  isPending,
  latest,
  Loading,
  onSettled,
  refresh,
  Show,
} from "solid-js";
import type { CronScratchGetResult, CronScratchSetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerCronEnglish);

type Props = {
  jobId: string;
  gateway: ApplicationContext["gateway"] | null;
  getRetired: () => Promise<void>;
};
type Scope = { jobId: string; gateway: ApplicationContext["gateway"]; epoch: number };

export function CronScratchEditor(props: Props) {
  let lifetime = Promise.withResolvers<void>();
  const retire = () => {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  };
  const page = useGatewayPage({
    getGateway: () => props.gateway,
    invalidateRequests: retire,
    onSnapshot: ({ snapshot }) => {
      // An access loss retires the read even if access returns before it settles.
      if (!readGatewayOperatorAccess(snapshot).canAdmin) {
        retire();
        page.invalidate();
      }
    },
  });
  onSettled(() => retire);
  const scope = createMemo<Scope | null>(
    () => {
      const gateway = props.gateway;
      return gateway &&
        gateway === page.gateway &&
        readGatewayOperatorAccess(page.snapshot).canAdmin
        ? { gateway, jobId: props.jobId, epoch: page.epoch }
        : null;
    },
    {
      equals: (a, b) => a?.gateway === b?.gateway && a?.jobId === b?.jobId && a?.epoch === b?.epoch,
    },
  );
  return (
    <openclaw-cron-scratch-editor>
      <Show when={scope()} keyed>
        {(owner) => (
          <ScratchFields
            scope={owner}
            connected={page.connected}
            getRetired={props.getRetired}
            getConnectionRetired={() => lifetime.promise}
            isCurrent={() =>
              props.gateway === owner.gateway &&
              props.jobId === owner.jobId &&
              page.readEpoch() === owner.epoch &&
              owner.gateway.snapshot.phase === "connected" &&
              readGatewayOperatorAccess(owner.gateway.snapshot).canAdmin
            }
          />
        )}
      </Show>
    </openclaw-cron-scratch-editor>
  );
}

function ScratchFields(props: {
  scope: Scope;
  connected: boolean;
  isCurrent: () => boolean;
  getRetired: () => Promise<void>;
  getConnectionRetired: () => Promise<void>;
}) {
  const [view, setView] = createStore<{
    snapshot: CronScratchGetResult | null;
    draft: string;
    message: string;
    conflict: boolean;
    redacted: boolean;
  }>({
    snapshot: null,
    draft: "",
    message: "",
    conflict: false,
    redacted: false,
  });
  const [readReceipt, setReadReceipt] = createSignal<Promise<void>>();
  const read = createMemo(() => readReceipt());
  const readResult = () => {
    latest(read);
    return null;
  };
  let pending = false;
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });
  const sizeBytes = createMemo(() => new TextEncoder().encode(view.draft).length);
  const snapshotRead = createMemo(() => view.snapshot);
  const [saving, setSaving] = createOptimistic(false);
  const disabled = () => saving() || isPending(read) || !props.connected || view.conflict;
  const isCurrent = () => !disposed && props.isCurrent();
  const presentSave = action(function* (
    result: Promise<void>,
    retired: Promise<void>,
    ownsPresentation: () => boolean,
  ) {
    try {
      if (ownsPresentation()) {
        setSaving(true);
        affects(snapshotRead);
      }
      yield Promise.race([result, retired]);
      if (ownsPresentation()) {
        yield refresh(snapshotRead);
      }
    } catch (error) {
      if (ownsPresentation()) {
        setView((state) => {
          state.message = formatUiError(error);
        });
      }
    }
  });

  async function save(content: string | null) {
    const lifetime = props.getRetired();
    const connectionLifetime = props.getConnectionRetired();
    const ownsPresentation = () =>
      isCurrent() &&
      props.getRetired() === lifetime &&
      props.getConnectionRetired() === connectionLifetime;
    const result = request(content);
    if (!result) {
      return;
    }
    await Promise.resolve();
    return presentSave(result, Promise.race([lifetime, connectionLifetime]), ownsPresentation);
  }

  function request(content?: string | null) {
    const client = props.scope.gateway.snapshot.client;
    const snapshot = view.snapshot;
    const isSave = content !== undefined;
    if (!client || !props.scope.jobId || pending || !isCurrent()) {
      return undefined;
    }
    if (isSave && (!snapshot || view.conflict)) {
      return undefined;
    }
    if (typeof content === "string" && view.redacted) {
      return undefined;
    }
    if (
      typeof content === "string" &&
      snapshot &&
      new TextEncoder().encode(content).length > snapshot.maxBytes
    ) {
      setView((state) => {
        state.message = t("cron.scratch.tooLarge");
      });
      return undefined;
    }
    // Guard duplicate admission synchronously; signals publish on the next Solid flush.
    pending = true;
    if (isSave) {
      setReadReceipt(undefined);
    }
    setView((state) => {
      state.message = "";
    });
    return (async () => {
      try {
        const result = isSave
          ? await client.request<CronScratchSetResult>("cron.scratch.set", {
              id: props.scope.jobId,
              content,
              expectedRevision: snapshot?.currentRevision,
            })
          : await client.request<CronScratchGetResult>("cron.scratch.get", {
              id: props.scope.jobId,
            });
        if (!isCurrent()) {
          return;
        }
        if ("reason" in result) {
          setView((state) => {
            state.conflict = true;
            state.message = t("cron.scratch.conflict");
          });
          return;
        }
        const raw = result.scratch?.content ?? "";
        const draft = redactToolDetail(raw);
        setView((state) => {
          // Retain revision metadata only; raw scratch must not enter diagnostic state dumps.
          state.snapshot = {
            ...result,
            scratch: result.scratch ? { ...result.scratch, content: "" } : null,
          };
          state.draft = draft;
          state.redacted = draft !== raw;
          state.conflict = false;
          state.message = isSave
            ? t(content === null ? "cron.scratch.removed" : "cron.scratch.saved")
            : "";
        });
      } catch (error) {
        if (isCurrent()) {
          if (!isSave) {
            throw error;
          }
          setView((state) => {
            state.message = formatUiError(error);
          });
        }
      } finally {
        pending = false;
      }
    })();
  }

  function loadScratch() {
    if (!pending && isCurrent()) {
      void setReadReceipt(request());
    }
  }

  return (
    <Loading>
      <section class="settings-section">
        <details>
          <summary class="settings-section__heading">{t("cron.scratch.title")}</summary>
          <p class="settings-section__desc">{t("cron.scratch.help")}</p>
          <button
            type="button"
            class="btn btn--sm"
            disabled={saving() || isPending(read) || !props.connected}
            onClick={loadScratch}
          >
            {t(view.snapshot ? "cron.scratch.reload" : "cron.scratch.load")}
          </button>
          <Show when={snapshotRead()}>
            <Show when={!snapshotRead()?.scratch}>
              <p class="cron-help">{t("cron.scratch.empty")}</p>
            </Show>
            <label class="field">
              <span>{t("cron.scratch.content")}</span>
              <textarea
                class="settings-input mono"
                rows={8}
                value={view.draft}
                readonly={disabled() || view.redacted}
                maxlength={snapshotRead()?.maxBytes}
                onInput={(event) => {
                  const draft = event.currentTarget.value;
                  setView((state) => {
                    state.draft = draft;
                  });
                }}
              />
            </label>
            <p class="cron-help">
              {t("cron.scratch.limit", {
                bytes: String(sizeBytes()),
                max: String(snapshotRead()?.maxBytes),
              })}
            </p>
            <Show when={view.redacted}>
              <p class="cron-help">{t("cron.scratch.redacted")}</p>
            </Show>
            <button
              type="button"
              class="btn btn--sm"
              disabled={
                disabled() || view.redacted || sizeBytes() > (snapshotRead()?.maxBytes ?? 0)
              }
              onClick={() => void save(view.draft)}
            >
              {t("cron.scratch.save")}
            </button>{" "}
            <button
              type="button"
              class="btn btn--sm danger"
              disabled={disabled() || !snapshotRead()?.scratch}
              onClick={() => void save(null)}
            >
              {t("cron.scratch.clear")}
            </button>
          </Show>
          <Errored
            fallback={(error) => (
              <p class="cron-help" role="status">
                {formatUiError(error())}
              </p>
            )}
          >
            {readResult()}
          </Errored>
          <Show when={view.message}>
            <p class="cron-help" role="status">
              {view.message}
            </p>
          </Show>
        </details>
      </section>
    </Loading>
  );
}
