import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { CronScratchGetResult, CronScratchSetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerCronEnglish);

type Props = { jobId: string; gateway: ApplicationContext["gateway"] | null };
type Scope = { jobId: string; gateway: ApplicationContext["gateway"]; epoch: number };

export function CronScratchEditor(props: Props) {
  const page = useGatewayPage({
    getGateway: () => props.gateway,
    onSnapshot: ({ snapshot }) => {
      // An access loss retires the read even if access returns before it settles.
      if (!readGatewayOperatorAccess(snapshot).canAdmin) {
        page.invalidate();
      }
    },
  });
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

function ScratchFields(props: { scope: Scope; connected: boolean; isCurrent: () => boolean }) {
  const [view, setView] = createSignal<{
    snapshot: CronScratchGetResult | null;
    draft: string;
    busy: boolean;
    message: string;
    conflict: boolean;
    redacted: boolean;
  }>({
    snapshot: null,
    draft: "",
    busy: false,
    message: "",
    conflict: false,
    redacted: false,
  });
  let pending = false;
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });
  const sizeBytes = createMemo(() => new TextEncoder().encode(view().draft).length);
  const disabled = () => view().busy || !props.connected || view().conflict;
  const isCurrent = () => !disposed && props.isCurrent();

  async function request(content?: string | null) {
    const client = props.scope.gateway.snapshot.client;
    const snapshot = view().snapshot;
    const saving = content !== undefined;
    if (!client || !props.scope.jobId || pending || !isCurrent()) {
      return;
    }
    if (saving && (!snapshot || view().conflict)) {
      return;
    }
    if (typeof content === "string" && view().redacted) {
      return;
    }
    if (
      typeof content === "string" &&
      snapshot &&
      new TextEncoder().encode(content).length > snapshot.maxBytes
    ) {
      setView((state) => ({ ...state, message: t("cron.scratch.tooLarge") }));
      return;
    }
    // Guard duplicate admission synchronously; signals publish on the next Solid flush.
    pending = true;
    setView((state) => ({ ...state, busy: true, message: "" }));
    try {
      const result = saving
        ? await client.request<CronScratchSetResult>("cron.scratch.set", {
            id: props.scope.jobId,
            content,
            expectedRevision: snapshot?.currentRevision,
          })
        : await client.request<CronScratchGetResult>("cron.scratch.get", { id: props.scope.jobId });
      if (!isCurrent()) {
        return;
      }
      if ("reason" in result) {
        setView((state) => ({ ...state, conflict: true, message: t("cron.scratch.conflict") }));
        return;
      }
      const raw = result.scratch?.content ?? "";
      const draft = redactToolDetail(raw);
      setView((state) => ({
        ...state,
        // Retain revision metadata only; raw scratch must not enter diagnostic state dumps.
        snapshot: {
          ...result,
          scratch: result.scratch ? { ...result.scratch, content: "" } : null,
        },
        draft,
        redacted: draft !== raw,
        conflict: false,
        message: saving ? t(content === null ? "cron.scratch.removed" : "cron.scratch.saved") : "",
      }));
    } catch (error) {
      if (isCurrent()) {
        setView((state) => ({ ...state, message: formatUiError(error) }));
      }
    } finally {
      pending = false;
      if (isCurrent()) {
        setView((state) => ({ ...state, busy: false }));
      }
    }
  }

  return (
    <section class="settings-section">
      <details>
        <summary class="settings-section__heading">{t("cron.scratch.title")}</summary>
        <p class="settings-section__desc">{t("cron.scratch.help")}</p>
        <button
          type="button"
          class="btn btn--sm"
          disabled={view().busy || !props.connected}
          onClick={() => void request()}
        >
          {t(view().snapshot ? "cron.scratch.reload" : "cron.scratch.load")}
        </button>
        <Show when={view().snapshot}>
          <Show when={!view().snapshot?.scratch}>
            <p class="cron-help">{t("cron.scratch.empty")}</p>
          </Show>
          <label class="field">
            <span>{t("cron.scratch.content")}</span>
            <textarea
              class="settings-input mono"
              rows={8}
              value={view().draft}
              readonly={disabled() || view().redacted}
              maxlength={view().snapshot?.maxBytes}
              onInput={(event) => {
                const draft = event.currentTarget.value;
                setView((state) => ({ ...state, draft }));
              }}
            />
          </label>
          <p class="cron-help">
            {t("cron.scratch.limit", {
              bytes: String(sizeBytes()),
              max: String(view().snapshot?.maxBytes),
            })}
          </p>
          <Show when={view().redacted}>
            <p class="cron-help">{t("cron.scratch.redacted")}</p>
          </Show>
          <button
            type="button"
            class="btn btn--sm"
            disabled={
              disabled() || view().redacted || sizeBytes() > (view().snapshot?.maxBytes ?? 0)
            }
            onClick={() => void request(view().draft)}
          >
            {t("cron.scratch.save")}
          </button>{" "}
          <button
            type="button"
            class="btn btn--sm danger"
            disabled={disabled() || !view().snapshot?.scratch}
            onClick={() => void request(null)}
          >
            {t("cron.scratch.clear")}
          </button>
        </Show>
        <Show when={view().message}>
          <p class="cron-help" role="status">
            {view().message}
          </p>
        </Show>
      </details>
    </section>
  );
}
