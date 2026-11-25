import { expect, it } from "vitest";
import { buildStatusChannelsTableRows } from "./channels-table.js";
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

it("neutralizes untrusted table fields before styling and preserves store line breaks", () => {
  const hostile = (text: string) => `\u001b]0;title\u0007\u001b[2J${text}\u0007\r\nnext\tcell`;
  const safe = (text: string) => `${text}\\r\\nnext\\tcell`;
  const warn = (text: string) => `\u001b[33m${text}\u001b[0m`;
  expect(
    buildStatusChannelsTableRows({
      rows: [
        {
          id: "evil",
          label: hostile("Channel"),
          enabled: true,
          state: "ok",
          detail: hostile("Detail"),
        },
      ],
      channelIssues: [{ channel: "evil", message: hostile("Issue") }],
      ok: colors.ok,
      warn,
      muted: colors.ok,
      accentDim: colors.ok,
    }),
  ).toEqual([
    {
      Channel: safe("Channel"),
      Enabled: "ok(ON)",
      State: warn("WARN"),
      Detail: `${safe("Detail")} · ${warn(`gateway: ${safe("Issue")}`)}`,
    },
  ]);
  expect(
    buildStatusAgentTableRows({
      agentStatus: {
        agents: [
          agent(hostile("agent"), {
            name: hostile("Name"),
            status: "degraded",
            sessionsPath: hostile("/tmp/store"),
            admissionRefusal: { reason: hostile("Refused"), repairHint: hostile("Recover") },
          }),
        ],
      },
      ok: colors.ok,
      warn,
    }),
  ).toEqual([
    row([
      `${safe("agent")} (${safe("Name")})${warn(" (degraded)")}`,
      "unknown",
      "unavailable",
      warn("refused"),
      `${safe("/tmp/store")}\n${safe("Refused")}\n${safe("Recover")}`,
    ]),
  ]);
  expect(
    buildStatusChannelDetailSections({
      details: [
        {
          title: hostile("Accounts"),
          columns: [hostile("Account"), "Status"],
          rows: [{ [hostile("Account")]: hostile("account"), Status: "WARN" }],
        },
      ],
      ok: colors.ok,
      warn,
    }),
  ).toEqual([
    {
      title: safe("Accounts"),
      columns: [
        { key: hostile("Account"), header: safe("Account"), flex: false, minWidth: 10 },
        { key: "Status", header: "Status", flex: false, minWidth: 10 },
      ],
      rows: [{ [hostile("Account")]: safe("account"), Status: warn("WARN") }],
    },
  ]);
});

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
