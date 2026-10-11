import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { DetailView } from "./view-detail.tsx";
import { ListView } from "./view-list.tsx";
import { CronSuggestionLists } from "./view-suggestions.tsx";
import type { CronProps } from "./view-types.ts";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/text.css";
import "../../styles/cron.css";
import "../../components/agent-row-chip.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
registerEnglishCatalog(registerCronEnglish);
export function CronView(props: CronProps) {
  const mode = () => (props.editingJob ? "job" : props.createOpen ? "create" : "overview");
  return (
    <>
      {mode() === "overview" ? <ListView {...props} /> : <DetailView {...props} mode={mode()} />}
      <CronSuggestionLists {...props} />
    </>
  );
}
