import { expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { copyMarkdownText } from "../../components/markdown-copy.ts";
import { CronRepairActions } from "./repair-actions.ts";

vi.mock("../../components/markdown-copy.ts", () => ({ copyMarkdownText: vi.fn() }));

it("keeps newer copy feedback when an older reset arrives and reports failures", () => {
  const first: CronRunLogEntry = {
    ts: 1,
    jobId: "first",
    action: "finished",
    status: "error",
  };
  const second: CronRunLogEntry = { ...first, ts: 2, jobId: "second" };
  const actions = new CronRepairActions(() => [first, second], vi.fn(), vi.fn());

  actions.copy(first, document.createElement("button"));
  const firstFeedback = vi.mocked(copyMarkdownText).mock.calls[0]?.[3];
  firstFeedback?.(true);
  actions.copy(second, document.createElement("button"));
  const secondFeedback = vi.mocked(copyMarkdownText).mock.calls[1]?.[3];
  secondFeedback?.(false);

  expect(actions.status).toEqual({ key: '["second",null,2]', result: "failed" });
  firstFeedback?.(undefined);
  expect(actions.status).toEqual({ key: '["second",null,2]', result: "failed" });
});
