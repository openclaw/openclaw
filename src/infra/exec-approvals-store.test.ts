import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { readOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import { makeTempDir } from "./exec-approvals-test-helpers.js";

const requestJsonlSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./jsonl-socket.js", () => ({
  requestJsonlSocket: (...args: unknown[]) => requestJsonlSocketMock(...args),
}));

import type { ExecApprovalsFile } from "./exec-approvals.js";

type ExecApprovalsModule = typeof import("./exec-approvals.js");

let addAllowlistEntry: ExecApprovalsModule["addAllowlistEntry"];
let addDurableCommandApproval: ExecApprovalsModule["addDurableCommandApproval"];
let ensureExecApprovals: ExecApprovalsModule["ensureExecApprovals"];
let loadExecApprovals: ExecApprovalsModule["loadExecApprovals"];
let mergeExecApprovalsSocketDefaults: ExecApprovalsModule["mergeExecApprovalsSocketDefaults"];
let normalizeExecApprovals: ExecApprovalsModule["normalizeExecApprovals"];
let persistAllowAlwaysPatterns: ExecApprovalsModule["persistAllowAlwaysPatterns"];
let readExecApprovalsSnapshot: ExecApprovalsModule["readExecApprovalsSnapshot"];
let recordAllowlistMatchesUse: ExecApprovalsModule["recordAllowlistMatchesUse"];
let recordAllowlistUse: ExecApprovalsModule["recordAllowlistUse"];
let requestExecApprovalViaSocket: ExecApprovalsModule["requestExecApprovalViaSocket"];
let resolveExecApprovalsStoreLocationForDisplay: ExecApprovalsModule["resolveExecApprovalsStoreLocationForDisplay"];
let resolveExecApprovalsSocketPath: ExecApprovalsModule["resolveExecApprovalsSocketPath"];
let saveExecApprovals: ExecApprovalsModule["saveExecApprovals"];

const tempDirs: string[] = [];
const originalOpenClawHome = process.env.OPENCLAW_HOME;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

beforeAll(async () => {
  ({
    addAllowlistEntry,
    addDurableCommandApproval,
    ensureExecApprovals,
    loadExecApprovals,
    mergeExecApprovalsSocketDefaults,
    normalizeExecApprovals,
    persistAllowAlwaysPatterns,
    readExecApprovalsSnapshot,
    recordAllowlistMatchesUse,
    recordAllowlistUse,
    requestExecApprovalViaSocket,
    resolveExecApprovalsStoreLocationForDisplay,
    resolveExecApprovalsSocketPath,
    saveExecApprovals,
  } = await import("./exec-approvals.js"));
});

beforeEach(() => {
  requestJsonlSocketMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHomeDir(): string {
  const dir = makeTempDir();
  const stateDir = makeTempDir();
  tempDirs.push(dir, stateDir);
  process.env.OPENCLAW_HOME = dir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return dir;
}

function readApprovalsFile(): ExecApprovalsFile {
  return loadExecApprovals();
}

function readSqliteRaw(): string | undefined {
  const value = readOpenClawStateKvJson("exec.approvals", "current");
  return typeof value === "string" ? value : undefined;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function allowlistEntries(agentId: string): Record<string, unknown>[] {
  const file = readApprovalsFile();
  return (file.agents?.[agentId]?.allowlist ?? []).map((entry) => requireRecord(entry));
}

function expectAllowlistEntryFields(
  entry: Record<string, unknown>,
  fields: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(entry[key]).toEqual(value);
  }
}

describe("exec approvals store helpers", () => {
  it("reports the SQLite store location and expands the socket path", () => {
    const dir = createHomeDir();

    expect(resolveExecApprovalsStoreLocationForDisplay()).toContain(
      path.join(process.env.OPENCLAW_STATE_DIR ?? "", "state", "openclaw.sqlite"),
    );
    expect(resolveExecApprovalsStoreLocationForDisplay()).toContain("#kv/exec.approvals/current");
    expect(path.normalize(resolveExecApprovalsSocketPath())).toBe(
      path.normalize(path.join(dir, ".openclaw", "exec-approvals.sock")),
    );
  });

  it("merges socket defaults from normalized, current, and built-in fallback", () => {
    const normalized = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/a.sock", token: "a" },
    });
    const current = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/b.sock", token: "b" },
    });

    expect(mergeExecApprovalsSocketDefaults({ normalized, current }).socket).toEqual({
      path: "/tmp/a.sock",
      token: "a",
    });
    expect(
      mergeExecApprovalsSocketDefaults({
        normalized: normalizeExecApprovals({ version: 1, agents: {} }),
        current,
      }).socket,
    ).toEqual({ path: "/tmp/b.sock", token: "b" });

    createHomeDir();
    expect(
      mergeExecApprovalsSocketDefaults({
        normalized: normalizeExecApprovals({ version: 1, agents: {} }),
      }).socket,
    ).toEqual({ path: resolveExecApprovalsSocketPath(), token: "" });
  });

  it("returns normalized snapshots from SQLite", () => {
    createHomeDir();

    const missing = readExecApprovalsSnapshot();
    expect(missing.exists).toBe(false);
    expect(missing.raw).toBeNull();
    expect(missing.file).toEqual(normalizeExecApprovals({ version: 1, agents: {} }));
    expect(missing.path).toBe(resolveExecApprovalsStoreLocationForDisplay());

    saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
    const sqlite = readExecApprovalsSnapshot();
    expect(sqlite.exists).toBe(true);
    expect(sqlite.file.defaults?.security).toBe("deny");
    expect(sqlite.raw).toContain('"security": "deny"');
  });

  it("ensures approvals in SQLite with default socket path and generated token", () => {
    createHomeDir();

    const ensured = ensureExecApprovals();
    const raw = readSqliteRaw();

    expect(ensured.socket?.path).toBe(resolveExecApprovalsSocketPath());
    expect(ensured.socket?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(raw?.endsWith("\n")).toBe(true);
    expect(readApprovalsFile().socket).toEqual(ensured.socket);
  });

  it("adds trimmed allowlist entries once and persists generated ids", () => {
    createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(123_456);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "  /usr/bin/rg  ");
    addAllowlistEntry(approvals, "worker", "/usr/bin/rg");
    addAllowlistEntry(approvals, "worker", "   ");

    const allowlist = allowlistEntries("worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/rg",
      lastUsedAt: 123_456,
    });
    expect(allowlist[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists durable command approvals without storing plaintext command text", () => {
    createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(321_000);

    const approvals = ensureExecApprovals();
    addDurableCommandApproval(approvals, "worker", 'printenv API_KEY="secret-value"');

    const allowlist = allowlistEntries("worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      source: "allow-always",
      lastUsedAt: 321_000,
    });
    expect(allowlist[0]?.pattern).toMatch(/^=command:[0-9a-f]{16}$/i);
    expect(allowlist[0]).not.toHaveProperty("commandText");
  });

  it("strips legacy plaintext command text during normalization", () => {
    const normalized = normalizeExecApprovals({
      version: 1,
      agents: {
        main: {
          allowlist: [
            {
              pattern: "=command:test",
              source: "allow-always",
              commandText: "echo secret-token",
            },
          ],
        },
      },
    });

    expect(normalized.agents?.main?.allowlist).toEqual([
      expect.objectContaining({ pattern: "=command:test", source: "allow-always" }),
    ]);
    expect(normalized.agents?.main?.allowlist?.[0]).not.toHaveProperty("commandText");
  });

  it("preserves source and argPattern metadata for allow-always entries", () => {
    createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(321_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", {
      argPattern: "^script\\.py\x00$",
      source: "allow-always",
    });
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", {
      argPattern: "^script\\.py\x00$",
      source: "allow-always",
    });
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", {
      argPattern: "^other\\.py\x00$",
      source: "allow-always",
    });

    const allowlist = allowlistEntries("worker");
    expect(allowlist).toHaveLength(2);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^script\\.py\x00$",
      source: "allow-always",
      lastUsedAt: 321_000,
    });
    expectAllowlistEntryFields(allowlist[1] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^other\\.py\x00$",
      source: "allow-always",
      lastUsedAt: 321_000,
    });
  });

  it("records allowlist usage on the matching entry and backfills missing ids", () => {
    createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(999_000);

    const approvals: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/rg" }, { pattern: "/usr/bin/jq", id: "keep-id" }],
        },
      },
    };
    saveExecApprovals(approvals);

    recordAllowlistUse(
      approvals,
      undefined,
      { pattern: "/usr/bin/rg" },
      "rg needle",
      "/opt/homebrew/bin/rg",
    );

    const allowlist = allowlistEntries("main");
    expect(allowlist).toHaveLength(2);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/rg",
      lastUsedAt: 999_000,
      lastUsedCommand: "rg needle",
      lastResolvedPath: "/opt/homebrew/bin/rg",
    });
    expect(allowlist[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(allowlist[1]).toEqual({ pattern: "/usr/bin/jq", id: "keep-id" });
  });

  it("dedupes allowlist usage by pattern and argPattern", () => {
    createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(777_000);

    const approvals: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/usr/bin/python3", argPattern: "^a\\.py\x00$" },
            { pattern: "/usr/bin/python3", argPattern: "^b\\.py\x00$" },
          ],
        },
      },
    };
    saveExecApprovals(approvals);

    recordAllowlistMatchesUse({
      approvals,
      agentId: undefined,
      matches: [
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py\x00$" },
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py\x00$" },
        { pattern: "/usr/bin/python3", argPattern: "^b\\.py\x00$" },
      ],
      command: "python3 a.py",
      resolvedPath: "/usr/bin/python3",
    });

    const allowlist = allowlistEntries("main");
    expect(allowlist).toHaveLength(2);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^a\\.py\x00$",
      lastUsedAt: 777_000,
    });
    expectAllowlistEntryFields(allowlist[1] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^b\\.py\x00$",
      lastUsedAt: 777_000,
    });
  });

  it("persists allow-always patterns with shared helper", () => {
    createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(654_321);

    const approvals = ensureExecApprovals();
    const patterns = persistAllowAlwaysPatterns({
      approvals,
      agentId: "worker",
      platform: "win32",
      segments: [
        {
          raw: "/usr/bin/custom-tool.exe a.py",
          argv: ["/usr/bin/custom-tool.exe", "a.py"],
          resolution: {
            execution: {
              rawExecutable: "/usr/bin/custom-tool.exe",
              resolvedPath: "/usr/bin/custom-tool.exe",
              executableName: "custom-tool",
            },
            policy: {
              rawExecutable: "/usr/bin/custom-tool.exe",
              resolvedPath: "/usr/bin/custom-tool.exe",
              executableName: "custom-tool",
            },
          },
        },
      ],
    });

    expect(patterns).toEqual([
      {
        pattern: "/usr/bin/custom-tool.exe",
        argPattern: "^a\\.py\x00$",
      },
    ]);
    const allowlist = allowlistEntries("worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/custom-tool.exe",
      argPattern: "^a\\.py\x00$",
      source: "allow-always",
      lastUsedAt: 654_321,
    });
  });

  it("returns null when approval socket credentials are missing", async () => {
    await expect(
      requestExecApprovalViaSocket({
        socketPath: "",
        token: "secret",
        request: { command: "echo hi" },
      }),
    ).resolves.toBeNull();
    await expect(
      requestExecApprovalViaSocket({
        socketPath: "/tmp/socket",
        token: "",
        request: { command: "echo hi" },
      }),
    ).resolves.toBeNull();
    expect(requestJsonlSocketMock).not.toHaveBeenCalled();
  });

  it("builds approval socket payloads and accepts decision responses only", async () => {
    requestJsonlSocketMock.mockImplementationOnce(async ({ requestLine, accept, timeoutMs }) => {
      expect(timeoutMs).toBe(15_000);
      const parsed = JSON.parse(requestLine) as {
        type: string;
        token: string;
        id: string;
        request: { command: string };
      };
      expect(parsed.type).toBe("request");
      expect(parsed.token).toBe("secret");
      expect(parsed.request).toEqual({ command: "echo hi" });
      expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(accept({ type: "noop", decision: "allow-once" })).toBeUndefined();
      expect(accept({ type: "decision", decision: "allow-always" })).toBe("allow-always");
      return "deny";
    });

    await expect(
      requestExecApprovalViaSocket({
        socketPath: "/tmp/socket",
        token: "secret",
        request: { command: "echo hi" },
      }),
    ).resolves.toBe("deny");
  });
});
