import { expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createRecordedCostUsage } from "./test-helpers/recorded-cost.test-support.ts";
import { createUsageProps } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

it("disables every export format while a report is being prepared", () => {
  const props = createUsageProps();
  const container = document.createElement("div");
  mountSolid(
    () =>
      renderUsage({
        ...props,
        data: { ...props.data, ...createRecordedCostUsage(), exporting: true },
      }),
    { container },
  );
  flush();
  for (const format of ["sessions-csv", "daily-csv", "json"]) {
    const item = container.querySelector<HTMLButtonElement>(
      `.usage-export-menu [data-value="${format}"]`,
    );
    expect(item?.disabled, format).toBe(true);
  }
});
