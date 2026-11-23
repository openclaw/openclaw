import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuItem } from "../../components/solid/menu.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createUsageRead, UsagePending } from "./read-status.tsx";
import type { UsageProps } from "./types.ts";

export function usageDisplaySessionCount(data: UsageProps["data"]): number {
  return (
    data.overview?.selectedSessionCount ??
    data.overview?.total ??
    data.aggregates?.sessionCount ??
    data.sessions.length
  );
}

export function usageExportItems(
  props: UsageProps,
  loading: boolean,
  icon?: () => JSX.Element,
): MenuItem[] {
  const data = props.data;
  const sessionCount = data.overview?.selectedRowCount ?? usageDisplaySessionCount(data);
  return [
    {
      id: "sessions-csv",
      label: t("usage.export.sessionsCsv"),
      icon: icon?.(),
      disabled: data.exporting || sessionCount === 0,
    },
    {
      id: "daily-csv",
      label: t("usage.export.dailyCsv"),
      icon: icon?.(),
      disabled: data.exporting || data.costDaily.length === 0,
    },
    {
      id: "json",
      label: t("usage.export.json"),
      icon: icon?.(),
      disabled: data.exporting || loading || (sessionCount === 0 && data.costDaily.length === 0),
    },
  ];
}

export function selectUsageExport(props: UsageProps, id: string) {
  switch (id) {
    case "sessions-csv":
    case "daily-csv":
      props.callbacks.display.onExportCsv(id);
      break;
    case "json":
      props.callbacks.display.onExportJson();
      break;
  }
}

/** Phone widths collect the page's refresh and export actions behind one trigger. */
export function UsagePhoneActions(props: UsageProps) {
  const read = createUsageRead(
    () => props.data.read,
    () => props.data.error,
  );
  return (
    <UsagePending read={read}>
      {(loading) => (
        <Menu
          id="usage-phone-actions"
          pointerFocus="trigger"
          label={t("usage.moreActions")}
          class="usage-phone-actions"
          triggerClass="btn btn--sm usage-phone-actions__trigger"
          placement="bottom-end"
          triggerAttributes={{ "aria-busy": props.data.exporting ? "true" : "false" }}
          trigger={<Icon name="moreHorizontal" />}
          items={[
            {
              id: "refresh",
              label: t("common.refresh"),
              icon: <Icon name="refresh" />,
              disabled: loading(),
            },
            ...usageExportItems(props, loading(), () => <Icon name="download" />),
          ]}
          onSelect={(item) =>
            item.id === "refresh"
              ? void props.callbacks.filters.onRefresh()
              : selectUsageExport(props, item.id)
          }
        />
      )}
    </UsagePending>
  );
}
