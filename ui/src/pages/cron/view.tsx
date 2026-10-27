import { lazy, Loading, Errored } from "solid-js";
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
  return (
    <>
      {mode() === "overview" ? (
        <ListView {...props} />
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
            <DetailView {...props} mode={mode()} />
          </Loading>
        </Errored>
      )}
    </>
  );
}
