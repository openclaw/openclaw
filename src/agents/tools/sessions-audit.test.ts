import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { exportExactSessionAudit } from "./sessions-audit.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { buildLocalSessionsIndex } from "./sessions-index.js";
import { normalizeUserProvidedSessionKey } from "./sessions-key-normalization.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { __testing as sessionsResolutionTesting } from "./sessions-resolution.js";

type GatewayRequest = { method?: string; params?: Record<string, unknown> };

const tempRoots: string[] = [];

function makeTempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tempRoots.push(root);
  return root;
}

function makeConfig(
  root: string,
  opts?: { visibility?: "self" | "tree" | "agent" | "all" },
): OpenClawConfig {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
      store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
    },
    tools: {
      sessions: { visibility: opts?.visibility ?? "all" },
      agentToAgent: { enabled: true },
    },
  } as OpenClawConfig;
}

function sessionDir(root: string, agentId = "main"): string {
  return path.join(root, "agents", agentId, "sessions");
}

function writeSessionStore(
  root: string,
  entries: Record<string, SessionEntry & Record<string, unknown>>,
  agentId = "main",
): void {
  const dir = sessionDir(root, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
    "utf8",
  );
}

function writeTranscript(
  root: string,
  sessionId: string,
  lines: string[],
  agentId = "main",
): string {
  const dir = sessionDir(root, agentId);
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return transcriptPath;
}

function parseJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  sessionsResolutionTesting.setDepsForTest(undefined);
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("session key normalization", () => {
  it("normalizes TUI aliases and canonical variants to the same canonical session key", () => {
    const expected = "agent:main:session tui-wave7";
    expect(normalizeUserProvidedSessionKey("session:tui-wave7")).toBe(expected);
    expect(normalizeUserProvidedSessionKey("session tui-wave7")).toBe(expected);
    expect(normalizeUserProvidedSessionKey("tui-wave7")).toBe(expected);
    expect(normalizeUserProvidedSessionKey("agent:main:tui-wave7")).toBe(expected);
    expect(normalizeUserProvidedSessionKey("agent:main:session:tui-wave7")).toBe(expected);
    expect(normalizeUserProvidedSessionKey("agent:main:session tui-wave7")).toBe(expected);
  });

  it("resolves all TUI aliases to the same local session file for audit export", async () => {
    const root = makeTempRoot("sessions-audit-aliases");
    const cfg = makeConfig(root);
    const canonicalKey = "agent:main:session tui-wave7";
    const storedLegacyKey = "agent:main:session:tui-wave7";
    const sessionId = "sid-wave7-alias";
    const transcriptPath = writeTranscript(root, sessionId, [
      JSON.stringify({ type: "message", message: { role: "user", content: "private body" } }),
    ]);
    writeSessionStore(root, {
      [storedLegacyKey]: {
        sessionId,
        updatedAt: 10,
        label: "Wave 7 audit",
        channel: "webchat",
      },
    });

    const aliases = [
      "session:tui-wave7",
      "session tui-wave7",
      "tui-wave7",
      "agent:main:tui-wave7",
      "agent:main:session:tui-wave7",
      canonicalKey,
    ];

    const exports = await Promise.all(
      aliases.map((sessionKey) =>
        exportExactSessionAudit({
          cfg,
          sessionKey,
          exportDir: path.join(root, "audits"),
        }),
      ),
    );

    for (const result of exports) {
      expect(result.auditComplete).toBe(true);
      expect(result.auditGrade).toBe(true);
      expect(result.canonicalKey).toBe(canonicalKey);
      expect(result.sessionFile).toBe(transcriptPath);
      expect(result.exportPath).toBe(exports[0]?.exportPath);
    }
  });
});

describe("exact session audit export", () => {
  it("exports a user-authorized older sibling session in complete redacted file-backed audit mode", async () => {
    const root = makeTempRoot("sessions-audit-sibling");
    const cfg = makeConfig(root, { visibility: "tree" });
    const targetKey = "agent:main:session tui-older-sibling";
    const requesterKey = "agent:main:main";
    const sessionId = "sid-older-sibling";
    writeTranscript(root, sessionId, [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "raw private transcript body should not print" },
        prompt: "RAW_SYSTEM_PROMPT_SHOULD_NOT_PRINT",
        tools: [{ name: "private_tool", schema: { secret: "TOOL_SCHEMA_SECRET" } }],
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "assistant body" }] },
      }),
    ]);
    writeSessionStore(root, {
      [targetKey]: {
        sessionId,
        updatedAt: 20,
        label: "Older sibling",
        channel: "webchat",
        spawnedBy: requesterKey,
      },
    });

    const calls: GatewayRequest[] = [];
    const gatewayCall = async <T>(request: GatewayRequest): Promise<T> => {
      calls.push(request);
      if (request.method === "sessions.list") {
        return { sessions: [{ key: targetKey }] } as T;
      }
      return {} as T;
    };
    sessionsResolutionTesting.setDepsForTest({ callGateway: gatewayCall as never });
    const tool = createSessionsHistoryTool({
      agentSessionKey: requesterKey,
      config: cfg,
      callGateway: gatewayCall as never,
      auditExportDir: path.join(root, "audits"),
    });

    const result = await tool.execute("call-audit-sibling", {
      sessionKey: "session:tui-older-sibling",
      audit: true,
    });
    const details = result.details as {
      auditComplete?: boolean;
      auditGrade?: boolean;
      redacted?: boolean;
      canonicalKey?: string;
      exportPath?: string;
      lineCount?: number;
      transcriptSha256?: string;
      exportSha256?: string;
    };

    expect(details.auditComplete).toBe(true);
    expect(details.auditGrade).toBe(true);
    expect(details.redacted).toBe(true);
    expect(details.canonicalKey).toBe(targetKey);
    expect(details.lineCount).toBe(2);
    expect(details.transcriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(details.exportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(details.exportPath).toBeTruthy();
    expect(calls.some((call) => call.method === "chat.history")).toBe(false);

    const exportPath = details.exportPath ?? "";
    const exportText = fs.readFileSync(exportPath, "utf8");
    expect(exportText).not.toContain("raw private transcript body should not print");
    expect(exportText).not.toContain("RAW_SYSTEM_PROMPT_SHOULD_NOT_PRINT");
    expect(exportText).not.toContain("TOOL_SCHEMA_SECRET");
    const records = parseJsonl(exportPath);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      auditMode: "exact-session-redacted-export",
      auditComplete: true,
      canonicalKey: targetKey,
      lineCount: 2,
      redacted: true,
    });
    expect(records[1]).toMatchObject({ lineNumber: 1 });
    expect(records[1]?.lineSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(records[2]).toMatchObject({ lineNumber: 2 });
    expect(records[2]?.lineSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks audit exports with truncation markers incomplete", async () => {
    const root = makeTempRoot("sessions-audit-truncated");
    const cfg = makeConfig(root);
    const key = "agent:main:session tui-truncated";
    const sessionId = "sid-truncated";
    writeTranscript(root, sessionId, [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "[... 12 more characters truncated]" },
      }),
    ]);
    writeSessionStore(root, { [key]: { sessionId, updatedAt: 30 } });

    const result = await exportExactSessionAudit({
      cfg,
      sessionKey: "tui-truncated",
      exportDir: path.join(root, "audits"),
    });

    expect(result.auditComplete).toBe(false);
    expect(result.auditGrade).toBe(false);
    expect(result.truncationMarkersDetected).toBe(true);
    expect(result.incompleteReason).toMatch(/truncation markers/i);
    const header = parseJsonl(result.exportPath ?? "")[0];
    expect(header).toMatchObject({ auditComplete: false, redacted: true });
  });
});

describe("sessions_history audit-grade boundaries", () => {
  it("rejects five-message/truncated history as audit evidence and points to file-backed export", async () => {
    const root = makeTempRoot("sessions-history-limited-audit");
    const cfg = makeConfig(root);
    const gatewayCall = async <T>(request: GatewayRequest): Promise<T> => {
      if (request.method === "sessions.list") {
        return { sessions: [] } as T;
      }
      if (request.method === "chat.history") {
        return {
          messages: Array.from({ length: 5 }, (_, index) => ({
            role: "assistant",
            content: [{ type: "text", text: `message ${index}` }],
          })),
        } as T;
      }
      return {} as T;
    };
    sessionsResolutionTesting.setDepsForTest({ callGateway: gatewayCall as never });
    const tool = createSessionsHistoryTool({ config: cfg, callGateway: gatewayCall as never });

    const auditResult = await tool.execute("call-limited-audit", {
      sessionKey: "main",
      limit: 5,
      includeTools: false,
      audit: true,
    });
    const auditDetails = auditResult.details as {
      auditComplete?: boolean;
      auditGrade?: boolean;
      incompleteReason?: string;
      fullAuditMode?: { tool?: string; arguments?: Record<string, unknown> };
      exportPath?: string;
    };
    expect(auditDetails.auditComplete).toBe(false);
    expect(auditDetails.auditGrade).toBe(false);
    expect(auditDetails.incompleteReason).toMatch(/limited sessions_history/i);
    expect(auditDetails.fullAuditMode).toMatchObject({
      tool: "sessions_history",
      arguments: { sessionKey: "main", audit: true },
    });
    expect(auditDetails.exportPath).toBeUndefined();

    const boundedResult = await tool.execute("call-limited-history", {
      sessionKey: "main",
      limit: 5,
      includeTools: false,
    });
    const boundedDetails = boundedResult.details as {
      messages?: unknown[];
      auditComplete?: boolean;
      auditGrade?: boolean;
      auditIncompleteReason?: string;
      fullAuditMode?: { tool?: string; arguments?: Record<string, unknown> };
    };
    expect(boundedDetails.messages).toHaveLength(5);
    expect(boundedDetails.auditComplete).toBe(false);
    expect(boundedDetails.auditGrade).toBe(false);
    expect(boundedDetails.auditIncompleteReason).toMatch(/not audit-grade/i);
    expect(boundedDetails.fullAuditMode).toMatchObject({
      tool: "sessions_history",
      arguments: { sessionKey: "main", audit: true },
    });
  });

  it("keeps unrelated exact audit browsing forbidden by the session visibility policy", async () => {
    const root = makeTempRoot("sessions-audit-forbidden");
    const cfg = makeConfig(root, { visibility: "self" });
    const requesterKey = "agent:main:main";
    const targetKey = "agent:main:session tui-unrelated";
    const sessionId = "sid-unrelated";
    writeTranscript(root, sessionId, [
      JSON.stringify({ type: "message", message: { role: "user", content: "private" } }),
    ]);
    writeSessionStore(root, { [targetKey]: { sessionId, updatedAt: 40 } });
    const gatewayCall = async <T>(): Promise<T> => ({}) as T;
    sessionsResolutionTesting.setDepsForTest({ callGateway: gatewayCall as never });
    const tool = createSessionsHistoryTool({
      agentSessionKey: requesterKey,
      config: cfg,
      callGateway: gatewayCall as never,
      auditExportDir: path.join(root, "audits"),
    });

    const result = await tool.execute("call-forbidden-audit", {
      sessionKey: "session:tui-unrelated",
      audit: true,
    });

    const details = result.details as { status?: string; error?: string; exportPath?: string };
    expect(details.status).toBe("forbidden");
    expect(details.error).toMatch(/visibility is restricted/i);
    expect(details.exportPath).toBeUndefined();
    expect(fs.existsSync(path.join(root, "audits"))).toBe(false);
  });
});

describe("bounded local session index fallback", () => {
  it("returns safe degraded local index rows on gateway timeout without raw prompt/tool/transcript bodies", async () => {
    const root = makeTempRoot("sessions-index-fallback");
    const cfg = makeConfig(root);
    const key = "agent:main:session tui-index";
    const sessionId = "sid-index";
    writeTranscript(root, sessionId, [
      JSON.stringify({ type: "message", message: { role: "user", content: "transcript body" } }),
    ]);
    writeSessionStore(root, {
      [key]: {
        sessionId,
        updatedAt: 50,
        startedAt: 45,
        label: "Index row",
        channel: "webchat",
        prompt: "RAW_PROMPT_BODY_SHOULD_NOT_PRINT",
        toolSchema: { private: "RAW_TOOL_SCHEMA_SHOULD_NOT_PRINT" },
        messages: [{ content: "RAW_TRANSCRIPT_BODY_SHOULD_NOT_PRINT" }],
      },
    });

    const tool = createSessionsListTool({
      config: cfg,
      callGateway: async () => {
        const err = new Error("deadline exceeded while calling sessions.list");
        err.name = "AbortError";
        throw err;
      },
    });

    const result = await tool.execute("call-index-timeout", { limit: 10 });
    const details = result.details as {
      degraded?: boolean;
      bounded?: boolean;
      source?: string;
      count?: number;
      sessions?: Array<Record<string, unknown>>;
    };
    expect(details.degraded).toBe(true);
    expect(details.bounded).toBe(true);
    expect(details.source).toBe("local-sessions-index");
    expect(details.count).toBe(1);
    expect(details.sessions).toEqual([
      expect.objectContaining({
        canonicalKey: key,
        sessionId,
        filePath: path.join(sessionDir(root), `${sessionId}.jsonl`),
        label: "Index row",
        channel: "webchat",
        updatedAt: 50,
        startedAt: 45,
      }),
    ]);
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain("RAW_PROMPT_BODY_SHOULD_NOT_PRINT");
    expect(serialized).not.toContain("RAW_TOOL_SCHEMA_SHOULD_NOT_PRINT");
    expect(serialized).not.toContain("RAW_TRANSCRIPT_BODY_SHOULD_NOT_PRINT");
    expect(details.sessions?.[0]).not.toHaveProperty("prompt");
    expect(details.sessions?.[0]).not.toHaveProperty("toolSchema");
    expect(details.sessions?.[0]).not.toHaveProperty("messages");
  });

  it("safe index helper emits only approved metadata fields", () => {
    const root = makeTempRoot("sessions-index-safe-helper");
    const cfg = makeConfig(root);
    const key = "agent:main:session tui-safe-index";
    const sessionId = "sid-safe-index";
    writeSessionStore(root, {
      [key]: {
        sessionId,
        updatedAt: 60,
        endedAt: 70,
        label: "Safe helper",
        channel: "webchat",
        prompt: "RAW_PROMPT_BODY_SHOULD_NOT_PRINT",
        toolSchema: { private: "RAW_TOOL_SCHEMA_SHOULD_NOT_PRINT" },
        transcript: "RAW_TRANSCRIPT_BODY_SHOULD_NOT_PRINT",
      },
    });

    const result = buildLocalSessionsIndex({ cfg, limit: 5 });
    expect(result.sessions).toHaveLength(1);
    expect(Object.keys(result.sessions[0] ?? {}).toSorted()).toEqual([
      "canonicalKey",
      "channel",
      "endedAt",
      "filePath",
      "label",
      "sessionId",
      "updatedAt",
    ]);
    expect(JSON.stringify(result)).not.toContain("RAW_PROMPT_BODY_SHOULD_NOT_PRINT");
    expect(JSON.stringify(result)).not.toContain("RAW_TOOL_SCHEMA_SHOULD_NOT_PRINT");
    expect(JSON.stringify(result)).not.toContain("RAW_TRANSCRIPT_BODY_SHOULD_NOT_PRINT");
  });
});
