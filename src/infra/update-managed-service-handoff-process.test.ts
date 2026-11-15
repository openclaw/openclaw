import type { ProcessAncestry, ProcessIdentity } from "@openclaw/proc-safe/identity";
import { beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";

const readProcessAncestry = vi.hoisted(() =>
  vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
);
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry,
}));
vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  isPidDefinitelyDead: () => false,
}));

const helperPid = 42;
const helper: ProcessIdentity = {
  pid: helperPid,
  parentPid: 1,
  startTimeMicros: 7_123_456,
  startTimeResolutionMicros: 1,
  exited: false,
};
const self: ProcessIdentity = { ...helper, pid: process.pid, parentPid: helperPid };
const reader = () => createManagedHandoffProcessIdentityReader({ env: {} });

beforeEach(() => {
  readProcessAncestry.mockReset();
});

it("validates a target ancestor and preserves the persisted seconds identity", () => {
  readProcessAncestry.mockReturnValue({
    chain: [self, helper],
    complete: true,
    stoppedBy: "through-pid",
  });
  const validate = vi.fn<
    Parameters<ReturnType<typeof reader>["validateDarwinAncestorProcesses"]>[1]
  >(
    (ancestors, current) =>
      ancestors.has(helperPid) &&
      current({ pid: helperPid, startIdentity: "7" }) &&
      !current({ pid: helperPid, startIdentity: "7123456" }),
  );
  expect(reader().validateDarwinAncestorProcesses(helperPid, validate)).toBe(true);
  expect(readProcessAncestry).toHaveBeenCalledWith(process.pid, {
    maxDepth: 34,
    throughPid: helperPid,
  });
});

it.each([
  null,
  { chain: [self, helper], complete: false, stoppedBy: "unreadable-parent" },
  { chain: [self, helper], complete: false, stoppedBy: "max-depth" },
  { chain: [self, helper], complete: false, stoppedBy: "cycle" },
  { chain: [self], complete: true, stoppedBy: "root" },
  { chain: [self], complete: true, stoppedBy: "missing-parent" },
  { chain: [self], complete: true, stoppedBy: "recycled-parent" },
] satisfies Array<ProcessAncestry | null>)(
  "refuses absent or incomplete target ancestry: %j",
  (ancestry) => {
    readProcessAncestry.mockReturnValue(ancestry);
    const validate = vi.fn(() => true);
    expect(reader().validateDarwinAncestorProcesses(helperPid, validate)).toBe(false);
    expect(validate).not.toHaveBeenCalled();
  },
);

it("treats an unreadable starting process as unknown", () => {
  readProcessAncestry.mockImplementation(() => {
    throw new Error("access denied");
  });
  expect(reader().validateDarwinAncestorProcesses(helperPid, () => true)).toBe(false);
});

it("does not authorize an exited target even when its kernel identity remains", () => {
  readProcessAncestry.mockReturnValue({
    chain: [self, { ...helper, exited: true }],
    complete: true,
    stoppedBy: "through-pid",
  });
  expect(
    reader().validateDarwinAncestorProcesses(helperPid, (_, current) =>
      current({ pid: helperPid, startIdentity: "7" }),
    ),
  ).toBe(false);
});
