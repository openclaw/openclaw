import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { windows, windowsSid } = vi.hoisted(() => ({ windows: vi.fn(), windowsSid: vi.fn() }));
vi.mock("./windows-process-census.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-process-census.js")>()),
  readWindowsProcessCensus: windows,
}));
vi.mock("./windows-user-sid.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-user-sid.js")>()),
  readWindowsUserSid: windowsSid,
}));
vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  isPidDefinitelyDead: () => false,
}));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
const references = { runId: "update-run-123", artifactPaths: ["/tmp/retained runtime"] };
const processRow = (pid: number, commandLine: string, cwd = "C:\\app") => ({
  pid,
  parentPid: 0,
  commandLine,
  cwd,
});
beforeEach(() => {
  windows.mockReset();
  windowsSid.mockReset();
  mockProcessPlatform("win32");
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ...[
    "openclaw update repair --run-id=update-run-123",
    String.raw`node --title "" "C:\app\openclaw.mjs" update repair --run-id=update-run-123`,
    String.raw`"C:\Program Files\node.exe" --title "C:\Team Notes\\" "C:\app\openclaw.mjs" update repair --run-id=update-run-123`,
  ].map((commandLine) => ({ parentStart: 100, commandLine })),
  { parentStart: 200, commandLine: "openclaw update repair --run-id=update-run-123" },
])(
  "excludes a Windows updater ancestor only with an earlier start ($parentStart, $commandLine)",
  ({ parentStart, commandLine }) => {
    windows.mockReturnValue([
      {
        ...processRow(self, "openclaw update repair"),
        parentPid: launcher,
        startIdentity: "200",
      },
      { ...processRow(launcher, commandLine), startIdentity: String(parentStart) },
      processRow(peer, 'node "C:\\Temp\\Retained Runtime\\tree\\worker.js"'),
      processRow(peer + 1, "node worker.js", "c:/temp/retained runtime/tree"),
      { pid: peer + 2 },
      { pid: peer + 3, foreignOwner: true },
      { pid: peer + 4, foreignOwner: true, commandLine: "node --id=update-run-123" },
      processRow(peer + 5, "node worker.js", "\\\\?\\C:\\Temp\\Retained Runtime\\tree"),
      processRow(peer + 6, 'node "file:///C:/Temp/Retained%20Runtime/tree/worker.js"'),
      processRow(peer + 7, '"unterminated.exe'),
      processRow(peer + 8, "node\0 --id=update-run-123"),
      processRow(peer + 9, ""),
    ]);
    expect(
      inspectOtherOpenClawProcesses({
        ...references,
        artifactPaths: ["c:\\temp\\retained runtime"],
      }),
    ).toEqual({
      matchingPids: [
        ...(parentStart >= 200 ? [launcher] : []),
        ...[0, 1, 4, 5, 6, 8].map((offset) => peer + offset),
      ],
      unverifiedPids: [peer + 2, peer + 7, peer + 9],
      warnings: [peer + 2, peer + 7, peer + 9].map((pid) => expect.stringContaining(`PID ${pid}`)),
    });
  },
);

type ProcessRow = ReturnType<
  typeof import("./windows-process-census.js").readWindowsProcessCensus
>[number];
type HandoffOptions = {
  sid?: string | null;
  legacy?: boolean;
  parents?: ProcessRow[];
  familyExited?: boolean;
};
type HandoffCase = [
  name: string,
  facts: Omit<ProcessRow, "pid">,
  result?: "matching" | "unverified",
  options?: HandoffOptions,
];
const identity = (parentPid: number, startIdentity = "300") => ({ parentPid, startIdentity });
const reusedParent = [{ pid: peer + 10, ...identity(0, "400") }];
const opaqueWorker = {
  ...identity(peer + 10),
  executable: "C:\\Windows\\DefenderSessionHelper.exe",
};
const denied = { accessDenied: true } as const;
const differentAccount = { sid: "S-1-5-21-200" };
const exited = { familyExited: true };
const reused = { parents: reusedParent };
const runtimeHolder = { ...identity(peer + 10), cwd: "/tmp/retained runtime/tree" };
const otherOpenClaw = { ...identity(0), commandLine: "openclaw-gateway" };
const readable = { ...identity(launcher), commandLine: "node worker.js", cwd: "C:\\app" };
const deniedParent = { parents: [{ pid: peer + 10, ...denied }] };
const reusedDriver = { parents: [{ pid: launcher, ...identity(0, "400") }] };
it.each<HandoffCase>([
  ["denied unrelated process, same account", denied],
  ["denied process, different account", denied, "unverified", differentAccount],
  ["denied process, unknown caller", denied, "unverified", { sid: null }],
  ["denied process, legacy record", denied, "unverified", { legacy: true }],
  ["unexplained missing identity", {}, "unverified"],
  ["protected unrelated process", identity(peer + 10, "100")],
  ["pre-handoff process with reused parent PID", identity(launcher, "100")],
  ["later-born process, reused parent", opaqueWorker, "unverified", reused],
  ["unreadable after family exit", identity(peer + 10), undefined, exited],
  ["runtime holder, reused parent", runtimeHolder, "matching", reused],
  ["OpenClaw after family exit", otherOpenClaw, "matching", exited],
  ["unrelated, different account", identity(peer + 10, "100"), undefined, differentAccount],
  ["descendant born in the same millisecond", identity(launcher, "200"), "matching"],
  ["unreadable descendant", identity(launcher), "matching"],
  ["descendant, reused driver PID", identity(launcher), "matching", reusedDriver],
  ["grandchild, reused intermediate PID", identity(peer + 10), "unverified", reused],
  ["surviving worker with an exited intermediate parent", opaqueWorker, "unverified"],
  ["worker, denied parent", identity(peer + 10), "unverified", deniedParent],
  ["readable descendant", readable, "matching"],
  [
    "positive artifact evidence on denied row",
    { accessDenied: true, commandLine: "node --id=update-run-123" },
    "matching",
  ],
])(
  "Windows handoff repair census: %s",
  (
    _name,
    facts,
    result,
    { sid = "S-1-5-21-100", legacy, parents, familyExited }: HandoffOptions = {},
  ) => {
    const matching = result === "matching";
    const unverified = result === "unverified";
    windowsSid.mockReturnValue(sid ?? undefined);
    windows.mockReturnValue([
      { ...processRow(self, "openclaw update repair"), startIdentity: "400" },
      { pid: peer, ...facts },
      ...(parents ?? []),
    ]);
    const observed = inspectOtherOpenClawProcesses({
      ...references,
      windowsUserSid: legacy ? undefined : "S-1-5-21-100",
      drivers: [{ pid: launcher, startIdentity: "200" }],
      familyExited,
    });
    expect(observed).toEqual({
      matchingPids: matching ? [peer] : [],
      unverifiedPids: unverified ? [peer] : [],
      ...(unverified ? { warnings: [expect.stringContaining(`PID ${peer}`)] } : {}),
    });
    if (unverified && facts.executable) {
      expect(observed.warnings?.[0]).toContain(path.win32.basename(facts.executable));
    }
  },
);
