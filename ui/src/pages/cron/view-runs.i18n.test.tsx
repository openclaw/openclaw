import { afterEach, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { RunsSection } from "./view-runs.tsx";
import { createCronViewProps, createCronViewRun } from "./view.test-support.ts";

afterEach(() => vi.restoreAllMocks());

it.each<{
  usage: NonNullable<CronRunLogEntry["usage"]>;
  key: string;
  params: Record<string, string>;
}>([
  {
    usage: { total_tokens: 1234 },
    key: "cron.runEntry.tokens",
    params: { count: formatCompactTokenCount(1234) },
  },
  {
    usage: { input_tokens: 1234, output_tokens: 5678 },
    key: "cron.runEntry.inputOutputTokens",
    params: { input: formatCompactTokenCount(1234), output: formatCompactTokenCount(5678) },
  },
])("localizes run token summary with $key", ({ usage, key, params }) => {
  const translate = vi.spyOn(i18n, "t");
  const expected = i18n.t(key, params);
  translate.mockClear();
  const props = createCronViewProps({ runs: [createCronViewRun({ usage })] });
  const { container, unmount } = mountSolid(() => <RunsSection {...props} />);
  try {
    expect(translate).toHaveBeenCalledWith(key, params);
    expect(container.textContent).toContain(expected);
  } finally {
    unmount();
  }
});
