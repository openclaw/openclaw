import type { createUsagePage } from "./usage-page-state.ts";
import type { UsageSessionEntry } from "./usage-state-types.ts";

export type * from "./usage-state-types.ts";

type UsageView = ReturnType<ReturnType<typeof createUsagePage>["read"]>;

export type UsageProps = Omit<UsageView, "data" | "result"> & {
  data: Omit<UsageView["data"], "overview" | "sessionPage" | "selectedSession"> & {
    overview?: UsageView["data"]["overview"];
    sessionPage?: Pick<
      NonNullable<UsageView["data"]["sessionPage"]>,
      "offset" | "limit" | "total" | "unfilteredSessionCount" | "tableTotals" | "tableSessionCount"
    >;
    selectedSession?: UsageSessionEntry | null;
  };
};
