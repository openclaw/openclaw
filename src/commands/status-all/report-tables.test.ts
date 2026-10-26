import { expect, it } from "vitest";
import { buildStatusChannelsTableRows } from "./channels-table.js";
import { buildStatusAgentTableRows, buildStatusChannelDetailSections } from "./report-tables.js";

it("neutralizes untrusted table fields before styling and preserves store line breaks", () => {
  const hostile = (text: string) => `\u001b]0;title\u0007\u001b[2J${text}\u0007\r\nnext\tcell`;
  const safe = (text: string) => `${text}\\r\\nnext\\tcell`;
  const warn = (text: string) => `\u001b[33m${text}\u001b[0m`;
  const colors = { ok: (value: string) => `ok(${value})`, warn };
  const channels = buildStatusChannelsTableRows({
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
    ...colors,
    muted: colors.ok,
    accentDim: colors.ok,
  });
  expect(channels).toEqual([
    {
      Channel: safe("Channel"),
      Enabled: "ok(ON)",
      State: warn("WARN"),
      Detail: `${safe("Detail")} · ${warn(`gateway: ${safe("Issue")}`)}`,
    },
  ]);
  const agents = buildStatusAgentTableRows({
    agentStatus: {
      agents: [
        {
          id: hostile("agent"),
          sessionsCount: 0,
          name: hostile("Name"),
          status: "degraded",
          sessionsPath: hostile("/tmp/store"),
          admissionRefusal: { reason: hostile("Refused"), repairHint: hostile("Recover") },
        },
      ],
    },
    ...colors,
  });
  expect(agents).toEqual([
    {
      Agent: `${safe("agent")} (${safe("Name")})${warn(" (degraded)")}`,
      BootstrapFile: "unknown",
      Sessions: "unavailable",
      Active: warn("refused"),
      Store: `${safe("/tmp/store")}\n${safe("Refused")}\n${safe("Recover")}`,
    },
  ]);
  const details = buildStatusChannelDetailSections({
    details: [
      {
        title: hostile("Accounts"),
        columns: [hostile("Account"), "Status"],
        rows: [{ [hostile("Account")]: hostile("account"), Status: "WARN" }],
      },
    ],
    ...colors,
  });
  expect(details).toEqual([
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
