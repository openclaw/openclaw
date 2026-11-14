import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import "../../styles.css";
import "../../styles/usage.css";
import { SessionDetailPanel } from "./view-details.tsx";
import { createUsageProps, usageSession } from "./view.test-support.ts";

registerUsageEnglish();

it("keeps long conversations bounded and navigates sparse tool disclosures", async () => {
  const props = createUsageProps();
  const logs = Array.from({ length: 1000 }, (_, index) => ({
    timestamp: Date.now() + index,
    role: "assistant" as const,
    content: `${index === 0 || index === 500 || index === 999 ? "[Tool: read]\n" : ""}Message ${index}\n${"Synthetic conversation content.\n".repeat(32)}`,
  }));
  const [expanded, setExpanded] = createSignal(false);
  const { container } = mountSolid(() => (
    <div style={{ height: "100vh", overflow: "auto" }}>
      <div class="usage-page">
        <SessionDetailPanel
          session={usageSession("synthetic-detail", "main", "openai")}
          detail={{
            ...props.detail,
            sessionLogs: logs,
            sessionLogsStatus: { ...props.detail.sessionLogsStatus, hasLoaded: true },
            sessionLogsExpanded: expanded(),
          }}
          callbacks={{
            ...props.callbacks.details,
            onToggleSessionLogsExpanded: () => setExpanded((value) => !value),
          }}
          range={props.filters}
          contextExpanded={false}
          onClose={() => {}}
        />
      </div>
    </div>
  ));
  const list = container.querySelector<HTMLDivElement>(".session-logs-list")!;
  await expect.poll(() => list.querySelectorAll(".session-log-entry").length).toBeGreaterThan(0);
  expect(list.querySelectorAll(".session-log-entry").length).toBeLessThan(30);
  expect(container.querySelector(".session-logs-header-count")?.textContent).toContain("1000");
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

  const firstDisclosure = list.querySelector<HTMLElement>('[aria-posinset="1"] summary')!;
  await userEvent.click(firstDisclosure);
  await expect.poll(() => list.querySelector('[aria-posinset="501"] summary')).not.toBeNull();
  expect(document.activeElement).toBe(firstDisclosure);
  await userEvent.tab();
  expect(document.activeElement?.closest(".session-log-entry")?.getAttribute("aria-posinset")).toBe(
    "501",
  );
  await userEvent.tab({ shift: true });
  expect(document.activeElement?.closest(".session-log-entry")?.getAttribute("aria-posinset")).toBe(
    "1",
  );

  list.scrollTop = list.scrollHeight;
  await expect
    .poll(() => {
      const last = list.querySelector<HTMLElement>('[aria-posinset="1000"]');
      return last && last.getBoundingClientRect().top < list.getBoundingClientRect().bottom;
    })
    .toBe(true);
  expect(list.querySelectorAll(".session-log-entry").length).toBeLessThan(30);
  expect(list.querySelector('[aria-posinset="1000"]')?.textContent).toContain("Message 999");

  const expand = [
    ...container.querySelectorAll<HTMLButtonElement>(".session-logs-header button"),
  ][0]!;
  expand.click();
  await expect.poll(() => list.querySelectorAll("details:not([open])").length).toBe(0);
  list.scrollTop = 0;
  await expect
    .poll(() => {
      const first = list.querySelector<HTMLElement>('[aria-posinset="1"]');
      return first && first.getBoundingClientRect().bottom > list.getBoundingClientRect().top;
    })
    .toBe(true);
  expect(list.querySelector("details")?.open).toBe(true);
});
