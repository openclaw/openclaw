import type { JSX } from "@solidjs/web";
import { SettingsSectionHeader } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { ConditionTriggerRows } from "./view-condition-trigger.tsx";
import { ToggleRow } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

export function TriggerSetupSection(props: {
  testId: string;
  description?: string;
  children: JSX.Element;
}) {
  return (
    <section class="settings-section">
      <SettingsSectionHeader title={t("cron.form.triggerSetup")} description={props.description} />
      <div class="settings-group cron-editor-card" data-test-id={props.testId}>
        {props.children}
      </div>
    </section>
  );
}

export function ProcessTriggerSetup(props: CronProps) {
  const stream = () => props.form.scheduleKind === "stream";
  return (
    <TriggerSetupSection
      testId="cron-process-trigger"
      description={t(stream() ? "cron.form.streamSourceHelp" : "cron.form.onExitHelp")}
    >
      {stream() ? (
        <ConditionTriggerRows {...props} />
      ) : (
        <ToggleRow
          {...props}
          field="deleteAfterRun"
          label={t("cron.form.deleteAfterRun")}
          help={t("cron.form.onExitDeleteHelp")}
        />
      )}
    </TriggerSetupSection>
  );
}
