import { lazy, Loading, Errored, onSettled } from "solid-js";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ListView } from "./view-list.tsx";
import type { CronProps } from "./view-types.ts";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/text.css";
import "../../styles/cron.css";
import "../../components/tooltip.ts";
registerEnglishCatalog(registerCronEnglish);
const DetailView = lazy(() => import("./view-detail.tsx"), { export: "DetailView" });
export function CronView(props: CronProps) {
  const mode = () => (props.editingJob ? "job" : props.createOpen ? "create" : "overview");
  let origin: string | undefined;
  let order: string[] = [];
  let pending: { candidates: string[]; active: Element; hello: unknown } | undefined;
  const prepareFocus = (candidates: string[]) => {
    const active = document.activeElement;
    pending = active?.matches(":focus-visible")
      ? { candidates, active, hello: props.gateway?.snapshot.hello }
      : undefined;
    return pending;
  };
  const focus: NonNullable<CronProps["focus"]> = {
    get target() {
      return (
        pending?.candidates.find(
          (id) => id === "back" || id === "create" || props.jobs.some((job) => job.id === id),
        ) ?? (pending ? (props.listTab === "activity" ? "create" : "search") : undefined)
      );
    },
    remember(id, rows) {
      origin = id;
      order = rows;
      prepareFocus(["back"]);
    },
    ref(id) {
      let element!: HTMLElement;
      onSettled(() => {
        if (!pending || id !== focus.target) {
          return;
        }
        const request = pending;
        pending = undefined;
        const active = document.activeElement;
        // Only replace the focus lost with this panel, never a newer user destination.
        if (
          props.gateway?.snapshot.hello === request.hello &&
          (active === document.body || active === request.active)
        ) {
          element.focus();
          element.scrollIntoView({ block: "nearest" });
        }
      });
      return (node) => (element = node);
    },
  };
  const close = () => {
    prepareFocus(props.listTab === "activity" ? ["create"] : origin ? [origin, ...order] : []);
    props.onClosePanel();
  };
  const remove: CronProps["onRemove"] = async (job) => {
    const index = order.indexOf(job.id);
    const request = prepareFocus([
      ...order.slice(index + 1),
      ...order.slice(0, index).toReversed(),
    ]);
    try {
      await props.onRemove(job);
    } finally {
      if (pending === request) {
        pending = undefined;
      }
    }
  };
  return (
    <>
      {mode() === "overview" ? (
        <ListView {...props} focus={focus} onRemove={remove} />
      ) : (
        <Errored
          fallback={(error, reset) => (
            <div role="alert">
              {String(error())}
              <button class="btn" onClick={reset}>
                {t("common.retry")}
              </button>
            </div>
          )}
        >
          <Loading fallback={<p role="status">{t("common.loading")}</p>}>
            <DetailView
              {...props}
              mode={mode()}
              focus={focus}
              onClosePanel={close}
              onRemove={remove}
            />
          </Loading>
        </Errored>
      )}
    </>
  );
}
