import { For, Show } from "solid-js";
import type { UpdateStatusResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  DocsLink,
  SettingsRow,
  SettingsSection,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatResourceBytes } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerSettingsEnglish);

type RecoveryUsage = NonNullable<UpdateStatusResult["recoveryCopies"]>;
const outcomeKeys = {
  candidate: "updates.recovery.candidate",
  protected: "updates.recovery.protected",
  blocked: "updates.recovery.blocked",
  "verification-required": "updates.recovery.verificationRequired",
  failed: "updates.recovery.failed",
} as const;

function reasonGuidance(reason: string): string {
  return t(
    reason === "artifact-metadata-changed"
      ? "updates.recovery.changedGuidance"
      : reason === "historical-import-proof-unavailable" ||
          reason === "historical-manifest-without-import-proof"
        ? "updates.recovery.historicalGuidance"
        : "updates.recovery.genericGuidance",
  );
}

/** Read-only projection. Recovery ownership and retirement stay with the CLI. */
export function RecoveryStorage(props: { usage: RecoveryUsage }) {
  const amount = (value: { count: number; logicalBytes: number }) =>
    t("updates.recovery.amount", {
      bytes: formatResourceBytes(value.logicalBytes),
      count: String(value.count),
    });
  return (
    <SettingsSection
      title={t("updates.recovery.title")}
      description={t("updates.recovery.description")}
      notice={
        <Show when={props.usage.incomplete}>
          <div class="callout warning" role="note">
            <strong>{t("updates.recovery.incomplete")}</strong>
            <div>{t("updates.recovery.incompleteDescription")}</div>
            <code>{props.usage.incompleteReasons.join(", ")}</code>
          </div>
        </Show>
      }
    >
      <SettingsRow
        title={t("updates.recovery.total")}
        control={<SettingsValue value={amount(props.usage.total)} />}
      />
      <For each={props.usage.byReason}>
        {(entry) => (
          <SettingsRow
            title={
              <>
                {t(outcomeKeys[entry.outcome])}: <code>{entry.reason}</code>
              </>
            }
            description={reasonGuidance(entry.reason)}
            stackedOnNarrow
            control={<SettingsValue value={amount(entry)} />}
          />
        )}
      </For>
      <SettingsRow
        title={
          <DocsLink url="https://docs.openclaw.ai/cli/update/repair-and-recovery#retained-session-import-archives">
            {t("updates.recovery.guidance")}
          </DocsLink>
        }
      />
    </SettingsSection>
  );
}
