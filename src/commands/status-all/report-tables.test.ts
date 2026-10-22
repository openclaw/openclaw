import { expect, it } from "vitest";
import { buildStatusAgentTableRows, buildStatusChannelDetailSections } from "./report-tables.js";

type Agent = Parameters<typeof buildStatusAgentTableRows>[0]["agentStatus"]["agents"][number];
const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  sessionsCount: 0,
  sessionsPath: `/tmp/${id}.json`,
  ...overrides,
});
const colors = { ok: (value: string) => `ok(${value})`, warn: (value: string) => `warn(${value})` };
type RowCells = [string, string, string, string, string];
const rowColumns = ["Agent", "BootstrapFile", "Sessions", "Active", "Store"];
const row = (cells: RowCells) =>
  Object.fromEntries(rowColumns.map((key, index) => [key, cells[index]]));

it.each([
  {
    name: "bootstrap presence, names, session counts and activity",
    agents: [
      agent("main", {
        name: "Primary",
        bootstrapPending: true,
        sessionsCount: 2,
        lastActiveAgeMs: 12_000,
      }),
      agent("ops", { bootstrapPending: false, lastActiveAgeMs: null }),
    ],
    expected: [
      row(["main (Primary)", "warn(PRESENT)", "2", "just now", "/tmp/main.json"]),
      row(["ops", "ok(ABSENT)", "0", "unknown", "/tmp/ops.json"]),
    ],
  },
  {
    name: "refused agent repair guidance without claiming a known session count",
    agents: [
      agent("cleaner", {
        status: "degraded",
        admissionRefusal: { reason: "Wrong owner", repairHint: "Quarantine copy" },
      }),
    ],
    expected: [
      expect.objectContaining({
        Agent: "cleanerwarn( (degraded))",
        Sessions: "unavailable",
        Active: "warn(refused)",
        Store: expect.stringMatching(/Wrong owner[\s\S]*Quarantine copy/),
      }),
    ],
  },
])("agent rows: $name", ({ agents, expected }) => {
  expect(buildStatusAgentTableRows({ agentStatus: { agents }, ...colors })).toEqual(expected);
});

it("builds colored detail table sections", () => {
  const [section] = buildStatusChannelDetailSections({
    details: [
      {
        title: "Channel detail",
        columns: ["Channel", "Status", "Notes"],
        rows: [{ Channel: "quietchat", Status: "WARN", Notes: "setup" }],
      },
    ],
    ...colors,
  });
  expect(section).toEqual({
    title: "Channel detail",
    columns: [
      { key: "Channel", header: "Channel", flex: false, minWidth: 10 },
      { key: "Status", header: "Status", flex: false, minWidth: 10 },
      { key: "Notes", header: "Notes", flex: true, minWidth: 28 },
    ],
    rows: [{ Channel: "quietchat", Status: "warn(WARN)", Notes: "setup" }],
  });
});
