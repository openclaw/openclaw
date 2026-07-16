export type WindowsListenerSnapshot = {
  known: boolean;
  pids: readonly number[];
};

export type WindowsNetTcpConnection = {
  LocalPort: number;
  State: string;
  OwningProcess: number;
};

function uniquePositivePids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))].toSorted(
    (left, right) => left - right,
  );
}

/** Normalizes the object properties emitted by Get-NetTCPConnection. */
export function listenerPidsFromNetTcpConnections(
  connections: readonly WindowsNetTcpConnection[],
  port: number,
): number[] {
  return uniquePositivePids(
    connections
      .filter(
        (connection) =>
          connection.LocalPort === port && connection.State.toUpperCase() === "LISTEN",
      )
      .map((connection) => connection.OwningProcess),
  );
}

function endpointPort(endpoint: string): number | null {
  const separator = endpoint.lastIndexOf(":");
  if (separator < 0) {
    return null;
  }
  const parsed = Number(endpoint.slice(separator + 1));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parses `netstat.exe -ano -p tcp` without inspecting localized headers/state.
 * Listening TCP rows have numeric local/foreign endpoints and foreign port 0.
 */
export function listenerPidsFromWindowsNetstat(output: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 5 || tokens[0]?.toUpperCase() !== "TCP") {
      continue;
    }
    if (endpointPort(tokens[1] ?? "") !== port || endpointPort(tokens[2] ?? "") !== 0) {
      continue;
    }
    const pid = Number(tokens.at(-1));
    if (Number.isSafeInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return uniquePositivePids(pids);
}

export type WindowsProcessIdentity = {
  pid: number;
  creationTimeFileTime: string;
  argv: readonly string[];
};

export type WindowsListenerKillDecision =
  | "kill"
  | "expected-command-unavailable"
  | "process-unavailable"
  | "command-mismatch"
  | "process-replaced"
  | "listener-query-unavailable"
  | "no-longer-listening";

export type WindowsListenerKillFacts = {
  candidatePid: number;
  expectedArgv: readonly string[];
  observedProcess: WindowsProcessIdentity | null;
  heldProcessCreationTimeFileTime: string | null;
  recheckedListeners: WindowsListenerSnapshot;
  recheckedProcess: WindowsProcessIdentity | null;
};

function windowsExecutableArgMatches(actual: string, expected: string): boolean {
  // CreateProcess can expand a bare launcher executable in the reported command line.
  // Qualified launcher paths and every non-executable argument stay exact.
  const expectedIsBare = !expected.includes("/") && !expected.includes("\\");
  if (!expectedIsBare) {
    return actual.toUpperCase() === expected.toUpperCase();
  }
  const actualBasename = actual.replaceAll("/", "\\").split("\\").at(-1) ?? actual;
  const normalizedActual = actualBasename.toUpperCase().endsWith(".EXE")
    ? actualBasename
    : `${actualBasename}.exe`;
  const expectedBasename = expected.toUpperCase().endsWith(".EXE") ? expected : `${expected}.exe`;
  return normalizedActual.toUpperCase() === expectedBasename.toUpperCase();
}

function argvMatches(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => {
    const expected = right[index];
    if (expected === undefined) {
      return false;
    }
    return index === 0
      ? windowsExecutableArgMatches(value, expected)
      : value.toUpperCase() === expected.toUpperCase();
  });
}

function isSameProcess(
  expected: WindowsProcessIdentity,
  actual: WindowsProcessIdentity | null,
): boolean {
  return (
    actual?.pid === expected.pid &&
    actual.creationTimeFileTime === expected.creationTimeFileTime &&
    argvMatches(actual.argv, expected.argv)
  );
}

/**
 * Pure fail-closed policy for the Windows updater's last-resort listener kill.
 * The caller must hold the same process handle represented by the creation time
 * before applying a `kill` result, so a recycled PID cannot change the target.
 */
export function decideWindowsListenerKill(
  facts: WindowsListenerKillFacts,
): WindowsListenerKillDecision {
  if (facts.expectedArgv.length === 0) {
    return "expected-command-unavailable";
  }
  const observed = facts.observedProcess;
  if (!observed || observed.pid !== facts.candidatePid) {
    return "process-unavailable";
  }
  if (!argvMatches(observed.argv, facts.expectedArgv)) {
    return "command-mismatch";
  }
  if (facts.heldProcessCreationTimeFileTime !== observed.creationTimeFileTime) {
    return "process-replaced";
  }
  if (!facts.recheckedListeners.known) {
    return "listener-query-unavailable";
  }
  if (!facts.recheckedListeners.pids.includes(facts.candidatePid)) {
    return "no-longer-listening";
  }
  if (!isSameProcess(observed, facts.recheckedProcess)) {
    return "process-replaced";
  }
  return "kill";
}

export type WindowsListenerOwnershipQuery = {
  getProcessIdentity(pid: number): Promise<WindowsProcessIdentity | null>;
  openProcessCreationTimeFileTime(pid: number): Promise<string | null>;
  getListenerSnapshot(port: number): Promise<WindowsListenerSnapshot>;
};

/** Collects Windows process/listener facts through an injected query boundary. */
export async function queryWindowsListenerKillDecision(params: {
  candidatePid: number;
  port: number;
  expectedArgv: readonly string[];
  query: WindowsListenerOwnershipQuery;
}): Promise<WindowsListenerKillDecision> {
  if (params.expectedArgv.length === 0) {
    return "expected-command-unavailable";
  }
  const observedProcess = await params.query.getProcessIdentity(params.candidatePid);
  if (!observedProcess) {
    return "process-unavailable";
  }
  if (!argvMatches(observedProcess.argv, params.expectedArgv)) {
    return "command-mismatch";
  }

  const heldProcessCreationTimeFileTime = await params.query.openProcessCreationTimeFileTime(
    params.candidatePid,
  );
  const recheckedListeners = await params.query.getListenerSnapshot(params.port);
  const recheckedProcess = await params.query.getProcessIdentity(params.candidatePid);
  return decideWindowsListenerKill({
    candidatePid: params.candidatePid,
    expectedArgv: params.expectedArgv,
    observedProcess,
    heldProcessCreationTimeFileTime,
    recheckedListeners,
    recheckedProcess,
  });
}
