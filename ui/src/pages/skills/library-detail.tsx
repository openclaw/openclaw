import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function LibraryIdentity(props: {
  entry: Pick<SkillLibraryEntry, "skillId" | "revision" | "name">;
}) {
  return (
    <details class="muted" style={{ "overflow-wrap": "anywhere", "min-width": "0" }}>
      <summary>{t("skillLibrary.technicalDetails")}</summary>
      <dl>
        <dt>{t("skillLibrary.skillId")}</dt>
        <dd>{props.entry.skillId}</dd>
        <dt>{t("skillLibrary.revision")}</dt>
        <dd>{props.entry.revision}</dd>
        <dt>{t("skillLibrary.command")}</dt>
        <dd>{props.entry.name}</dd>
      </dl>
    </details>
  );
}

export function LibraryDialogHeader(props: { title: string; onClose: () => void; busy?: boolean }) {
  return (
    <div class="exec-approval-header">
      <strong class="exec-approval-title">{props.title}</strong>
      <button
        type="button"
        class="btn btn--icon btn--ghost"
        aria-label={t("common.close")}
        disabled={props.busy}
        onClick={() => props.onClose()}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
