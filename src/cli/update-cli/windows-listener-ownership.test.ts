import { describe, expect, it, vi } from "vitest";
import {
  decideWindowsListenerKill,
  listenerPidsFromNetTcpConnections,
  listenerPidsFromWindowsNetstat,
  queryWindowsListenerKillDecision,
  type WindowsListenerOwnershipQuery,
  type WindowsProcessIdentity,
} from "./windows-listener-ownership.js";

const pid = 4242;
const port = 18789;
const creationTimeFileTime = "133987654321000000";
const expectedArgv = [
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\Users\\Test User\\openclaw\\dist\\entry.js",
  "gateway",
  "--port",
  String(port),
];

function processIdentity(overrides: Partial<WindowsProcessIdentity> = {}): WindowsProcessIdentity {
  return {
    pid,
    creationTimeFileTime,
    argv: expectedArgv,
    ...overrides,
  };
}

function killFacts(
  overrides: Partial<Parameters<typeof decideWindowsListenerKill>[0]> = {},
): Parameters<typeof decideWindowsListenerKill>[0] {
  return {
    candidatePid: pid,
    expectedArgv,
    observedProcess: processIdentity(),
    heldProcessCreationTimeFileTime: creationTimeFileTime,
    recheckedListeners: { known: true, pids: [pid] },
    recheckedProcess: processIdentity(),
    ...overrides,
  };
}

function queryMock(overrides: Partial<WindowsListenerOwnershipQuery> = {}) {
  return {
    getProcessIdentity: vi.fn(async () => processIdentity()),
    openProcessCreationTimeFileTime: vi.fn(async () => creationTimeFileTime),
    getListenerSnapshot: vi.fn(async () => ({ known: true, pids: [pid] })),
    ...overrides,
  } satisfies WindowsListenerOwnershipQuery;
}

describe("Windows listener command output", () => {
  it("normalizes real Get-NetTCPConnection object properties", () => {
    expect(
      listenerPidsFromNetTcpConnections(
        [
          { LocalPort: port, State: "Listen", OwningProcess: pid },
          { LocalPort: port, State: "Listen", OwningProcess: pid },
          { LocalPort: port, State: "Established", OwningProcess: 5252 },
          { LocalPort: 443, State: "Listen", OwningProcess: 6262 },
        ],
        port,
      ),
    ).toEqual([pid]);
  });

  it("parses real IPv4/IPv6 netstat columns without depending on localized state text", () => {
    const output = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:18789          0.0.0.0:0              LISTENING       4242
  TCP    [::]:18789             [::]:0                 ABHÖREN         4242
  TCP    127.0.0.1:18789        127.0.0.1:61234        ESTABLISHED     5252
  TCP    0.0.0.0:443            0.0.0.0:0              LISTENING       6262
`;
    expect(listenerPidsFromWindowsNetstat(output, port)).toEqual([pid]);
  });
});

describe("decideWindowsListenerKill", () => {
  it("kills the exact launcher-derived child process after identity and listener rechecks", () => {
    expect(decideWindowsListenerKill(killFacts())).toBe("kill");
  });

  it("matches Windows argv casing without accepting extra arguments", () => {
    expect(
      decideWindowsListenerKill(
        killFacts({
          observedProcess: processIdentity({ argv: expectedArgv.map((arg) => arg.toUpperCase()) }),
        }),
      ),
    ).toBe("kill");
    expect(
      decideWindowsListenerKill(
        killFacts({ observedProcess: processIdentity({ argv: [...expectedArgv, "--foreign"] }) }),
      ),
    ).toBe("command-mismatch");
  });

  it("matches a bare configured executable to Windows' resolved image path", () => {
    const bareExpectedArgv = ["node", ...expectedArgv.slice(1)];
    expect(
      decideWindowsListenerKill(
        killFacts({
          expectedArgv: bareExpectedArgv,
          observedProcess: processIdentity(),
          recheckedProcess: processIdentity(),
        }),
      ),
    ).toBe("kill");
  });

  it.each([
    ["missing installed command", { expectedArgv: [] }, "expected-command-unavailable"],
    ["CIM access denied", { observedProcess: null }, "process-unavailable"],
    [
      "foreign listener",
      { observedProcess: processIdentity({ argv: ["python.exe", "foreign-listener.py"] }) },
      "command-mismatch",
    ],
    [
      "same gateway basename from another path",
      {
        observedProcess: processIdentity({
          argv: ["C:\\Other\\openclaw-gateway.exe", "gateway", "--port", String(port)],
        }),
      },
      "command-mismatch",
    ],
    [
      "PID recycled before handle acquisition",
      { heldProcessCreationTimeFileTime: "133987654399000000" },
      "process-replaced",
    ],
    [
      "listener query denied",
      { recheckedListeners: { known: false, pids: [] } },
      "listener-query-unavailable",
    ],
    [
      "process stopped listening",
      { recheckedListeners: { known: true, pids: [] } },
      "no-longer-listening",
    ],
    ["PID vanished before recheck", { recheckedProcess: null }, "process-replaced"],
    [
      "PID recycled before recheck",
      { recheckedProcess: processIdentity({ creationTimeFileTime: "133987654399000000" }) },
      "process-replaced",
    ],
    [
      "command changed before recheck",
      { recheckedProcess: processIdentity({ argv: ["python.exe", "foreign-listener.py"] }) },
      "process-replaced",
    ],
  ] as const)("fails closed when %s", (_name, overrides, expected) => {
    expect(decideWindowsListenerKill(killFacts(overrides))).toBe(expected);
  });

  it("selects only the managed PID from IPv4/IPv6 and foreign listeners", () => {
    const snapshot = { known: true, pids: [pid, 5252] };
    expect(decideWindowsListenerKill(killFacts({ recheckedListeners: snapshot }))).toBe("kill");
    expect(
      decideWindowsListenerKill(
        killFacts({
          candidatePid: 5252,
          observedProcess: processIdentity({
            pid: 5252,
            argv: ["python.exe", "foreign-listener.py"],
          }),
          recheckedListeners: snapshot,
          recheckedProcess: processIdentity({
            pid: 5252,
            argv: ["python.exe", "foreign-listener.py"],
          }),
        }),
      ),
    ).toBe("command-mismatch");
  });
});

describe("queryWindowsListenerKillDecision", () => {
  it("uses the injected Windows query layer in race-safe order", async () => {
    const calls: string[] = [];
    const query = queryMock({
      getProcessIdentity: vi.fn(async () => {
        calls.push("process");
        return processIdentity();
      }),
      openProcessCreationTimeFileTime: vi.fn(async () => {
        calls.push("handle");
        return creationTimeFileTime;
      }),
      getListenerSnapshot: vi.fn(async () => {
        calls.push("listeners");
        return { known: true, pids: [pid] };
      }),
    });

    await expect(
      queryWindowsListenerKillDecision({ candidatePid: pid, port, expectedArgv, query }),
    ).resolves.toBe("kill");
    expect(calls).toEqual(["process", "handle", "listeners", "process"]);
  });

  it("does not acquire a handle for a foreign listener", async () => {
    const query = queryMock({
      getProcessIdentity: vi.fn(async () =>
        processIdentity({ argv: ["powershell.exe", "-File", "foreign-listener.ps1"] }),
      ),
    });

    await expect(
      queryWindowsListenerKillDecision({ candidatePid: pid, port, expectedArgv, query }),
    ).resolves.toBe("command-mismatch");
    expect(query.openProcessCreationTimeFileTime).not.toHaveBeenCalled();
    expect(query.getListenerSnapshot).not.toHaveBeenCalled();
  });
});
