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
// Synthetic package identities keep Windows path classification independent of the host.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const io = {
    readFileSync: (file: string) =>
      JSON.stringify({
        name:
          file.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "") === "/app/package.json"
            ? "openclaw"
            : "unrelated-service",
      }),
    realpathSync: (file: string) => file,
    statSync: () => ({ isDirectory: () => false }),
    readdirSync: () => [],
    readlinkSync: () => "/app",
  };
  return { ...fs, ...io, default: { ...fs, ...io } };
});
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
const references = { runId: "update-run-123", artifactPaths: ["/tmp/retained runtime"] };
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
    mockProcessPlatform("win32");
    const processRow = (pid: number, argv: string, cwd = "C:\\app") => ({
      pid,
      parentPid: 0,
      commandLine: argv,
      cwd,
    });
    windows.mockReturnValue([
      {
        ...processRow(self, "openclaw update repair"),
        parentPid: launcher,
        startIdentity: "200",
      },
      {
        ...processRow(launcher, commandLine),
        startIdentity: String(parentStart),
      },
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
        peer,
        peer + 1,
        peer + 4,
        peer + 5,
        peer + 6,
        peer + 8,
      ],
      unverifiedPids: [peer + 2, peer + 7, peer + 9],
      warnings: [peer + 2, peer + 7, peer + 9].map((pid) => expect.stringContaining(`PID ${pid}`)),
    });
  },
);

it.each([
  {
    name: "denied unrelated process, same account",
    sid: "S-1-5-21-100",
    facts: { accessDenied: true },
  },
  {
    name: "denied process, different account",
    sid: "S-1-5-21-200",
    facts: { accessDenied: true },
    unverified: true,
  },
  {
    name: "denied process, unknown caller",
    sid: undefined,
    facts: { accessDenied: true },
    unverified: true,
  },
  {
    name: "denied process, legacy record",
    sid: "S-1-5-21-100",
    legacy: true,
    facts: { accessDenied: true },
    unverified: true,
  },
  {
    name: "unexplained missing identity",
    sid: "S-1-5-21-100",
    facts: {},
    unverified: true,
  },
  {
    name: "protected unrelated process",
    sid: "S-1-5-21-100",
    facts: { parentPid: peer + 10, startIdentity: "100" },
  },
  {
    name: "pre-handoff process with reused parent PID",
    sid: "S-1-5-21-100",
    facts: { parentPid: launcher, startIdentity: "100" },
  },
  {
    name: "protected later-born process with a reused parent PID",
    sid: "S-1-5-21-100",
    facts: {
      parentPid: peer + 10,
      startIdentity: "300",
      executable: "C:\\Windows\\DefenderSessionHelper.exe",
    },
    parents: [{ pid: peer + 10, parentPid: 0, startIdentity: "400" }],
    unverified: true,
  },
  {
    name: "unreadable process after the recorded family boot ended",
    sid: "S-1-5-21-100",
    facts: { parentPid: peer + 10, startIdentity: "300" },
    familyExited: true,
  },
  {
    name: "runtime holder behind a reused parent PID",
    sid: "S-1-5-21-100",
    facts: { parentPid: peer + 10, startIdentity: "300", cwd: "/tmp/retained runtime/tree" },
    parents: [{ pid: peer + 10, parentPid: 0, startIdentity: "400" }],
    matching: true,
  },
  {
    name: "positive OpenClaw identity with unrelated ancestry",
    sid: "S-1-5-21-100",
    facts: { parentPid: 0, startIdentity: "300", commandLine: "openclaw-gateway" },
    matching: true,
    familyExited: true,
  },
  {
    name: "readable unrelated process from another account",
    sid: "S-1-5-21-200",
    facts: { parentPid: peer + 10, startIdentity: "100" },
  },
  {
    name: "descendant born in the same millisecond",
    sid: "S-1-5-21-100",
    facts: { parentPid: launcher, startIdentity: "200" },
    matching: true,
  },
  {
    name: "unreadable descendant",
    sid: "S-1-5-21-100",
    facts: { parentPid: launcher, startIdentity: "300" },
    matching: true,
  },
  {
    name: "surviving descendant after the recorded driver's PID is reused",
    sid: "S-1-5-21-100",
    facts: { parentPid: launcher, startIdentity: "300" },
    parents: [{ pid: launcher, parentPid: 0, startIdentity: "400" }],
    matching: true,
  },
  {
    name: "surviving grandchild after an unrecorded intermediate parent's PID is reused",
    sid: "S-1-5-21-100",
    facts: { parentPid: peer + 10, startIdentity: "300" },
    parents: [{ pid: peer + 10, parentPid: 0, startIdentity: "400" }],
    unverified: true,
  },
  {
    name: "surviving worker with an exited intermediate parent",
    sid: "S-1-5-21-100",
    facts: {
      parentPid: peer + 10,
      startIdentity: "300",
      executable: "C:\\Windows\\DefenderSessionHelper.exe",
    },
    unverified: true,
  },
  {
    name: "surviving worker whose parent PID now denies access",
    sid: "S-1-5-21-100",
    facts: { parentPid: peer + 10, startIdentity: "300" },
    parents: [{ pid: peer + 10, accessDenied: true }],
    unverified: true,
  },
  {
    name: "readable descendant",
    sid: "S-1-5-21-100",
    facts: {
      parentPid: launcher,
      startIdentity: "300",
      commandLine: "node worker.js",
      cwd: "C:\\app",
    },
    matching: true,
  },
  {
    name: "positive artifact evidence on denied row",
    sid: "S-1-5-21-100",
    facts: { accessDenied: true, commandLine: "node --id=update-run-123" },
    matching: true,
  },
])(
  "Windows handoff repair census: $name",
  ({ sid, facts, matching = false, unverified = false, legacy, parents, familyExited }) => {
    mockProcessPlatform("win32");
    windowsSid.mockReturnValue(sid);
    windows.mockReturnValue([
      {
        pid: self,
        parentPid: 0,
        startIdentity: "400",
        commandLine: "openclaw update repair",
        cwd: "C:\\app",
      },
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
