import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { listSubagentRunsForRequester, type SubagentRunRecord } from "../subagent-registry.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SessionsVerifyToolSchema = Type.Object({
  sessionKey: Type.String({
    description: "Session key of the subagent to verify",
  }),
  expectedArtifacts: Type.Optional(
    Type.Array(Type.String(), {
      description: "File paths or glob patterns to check for existence",
    }),
  ),
  requiredPatterns: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex patterns that must appear in the session transcript",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 120,
      description: "Max seconds to wait if session is still running (default 30)",
    }),
  ),
});

function findRunBySessionKey(
  requesterSessionKey: string,
  childSessionKey: string,
): SubagentRunRecord | undefined {
  const runs = listSubagentRunsForRequester(requesterSessionKey);
  return runs.find((r) => r.childSessionKey === childSessionKey);
}

async function checkArtifacts(patterns: string[]): Promise<{ pattern: string; found: boolean }[]> {
  const results: { pattern: string; found: boolean }[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?")) {
      // Simple glob: list parent dir and match basename
      const dir = path.dirname(pattern);
      const basePat = path
        .basename(pattern)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      const re = new RegExp(`^${basePat}$`);
      try {
        const entries = await fs.readdir(dir);
        const found = entries.some((e) => re.test(e));
        results.push({ pattern, found });
      } catch {
        results.push({ pattern, found: false });
      }
    } else {
      try {
        await fs.access(pattern);
        results.push({ pattern, found: true });
      } catch {
        results.push({ pattern, found: false });
      }
    }
  }
  return results;
}

async function checkTranscriptPatterns(
  sessionKey: string,
  patterns: string[],
  timeoutMs: number,
): Promise<{
  sessionStatus: "running" | "completed" | "error" | "not_found";
  patternResults: { pattern: string; found: boolean }[];
}> {
  const cfg = loadConfig();
  // Try fetching session history
  try {
    const history = await callGateway<{
      messages: { role: string; content: unknown[] }[];
    }>({
      method: "chat.history",
      params: { key: sessionKey, limit: 100 },
      timeoutMs: Math.min(timeoutMs, 10_000),
    });

    const transcript = (history?.messages ?? [])
      .map((msg) => {
        if (!Array.isArray(msg.content)) return "";
        return msg.content
          .filter(
            (c: unknown): c is { type: string; text: string } =>
              typeof c === "object" &&
              c !== null &&
              (c as { type?: string }).type === "text" &&
              typeof (c as { text?: string }).text === "string",
          )
          .map((c) => c.text)
          .join("\n");
      })
      .join("\n");

    const patternResults = patterns.map((pattern) => {
      try {
        const re = new RegExp(pattern, "i");
        return { pattern, found: re.test(transcript) };
      } catch {
        return { pattern, found: false };
      }
    });

    return { sessionStatus: "completed", patternResults };
  } catch {
    return {
      sessionStatus: "not_found",
      patternResults: patterns.map((p) => ({ pattern: p, found: false })),
    };
  }
}

export function createSessionsVerifyTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_verify",
    description:
      "Verify that a spawned subagent completed its task successfully. " +
      "Checks session completion status, expected output artifacts (file existence), " +
      "and required patterns in the session transcript. " +
      "Polls every 2s until timeout if the session is still running.",
    parameters: SessionsVerifyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey", { required: true });
      const expectedArtifacts = Array.isArray(params.expectedArtifacts)
        ? (params.expectedArtifacts as string[]).filter((s) => typeof s === "string" && s.trim())
        : [];
      const requiredPatterns = Array.isArray(params.requiredPatterns)
        ? (params.requiredPatterns as string[]).filter((s) => typeof s === "string" && s.trim())
        : [];
      const timeoutSeconds = readNumberParam(params, "timeoutSeconds") ?? 30;
      const timeoutMs = Math.min(timeoutSeconds, 120) * 1000;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({
            key: opts.agentSessionKey,
            alias,
            mainKey,
          })
        : alias;

      // Find the subagent run record
      const run = findRunBySessionKey(requesterSessionKey, sessionKey);
      if (!run) {
        return jsonResult({
          status: "not_found",
          error: `No subagent run found for session key: ${sessionKey}`,
        });
      }

      // Wait for completion if still running
      const deadline = Date.now() + timeoutMs;
      let currentRun = run;
      while (!currentRun.endedAt && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const refreshed = findRunBySessionKey(requesterSessionKey, sessionKey);
        if (refreshed) currentRun = refreshed;
      }

      const isRunning = !currentRun.endedAt;
      const runStatus = isRunning
        ? "running"
        : currentRun.outcome?.status === "ok"
          ? "completed"
          : currentRun.outcome?.status === "error"
            ? "error"
            : "completed";

      if (isRunning) {
        return jsonResult({
          status: "timeout",
          summary: `Session ${sessionKey} is still running after ${timeoutSeconds}s`,
          runId: currentRun.runId,
          runtimeSeconds: Math.round(
            (Date.now() - (currentRun.startedAt ?? currentRun.createdAt)) / 1000,
          ),
        });
      }

      // Check artifacts
      const artifactChecks =
        expectedArtifacts.length > 0 ? await checkArtifacts(expectedArtifacts) : [];

      // Check transcript patterns
      const transcriptChecks =
        requiredPatterns.length > 0
          ? await checkTranscriptPatterns(sessionKey, requiredPatterns, timeoutMs)
          : { sessionStatus: runStatus as string, patternResults: [] };

      // Compute overall status
      const artifactsOk = artifactChecks.every((a) => a.found);
      const patternsOk = transcriptChecks.patternResults.every((p) => p.found);
      const overallStatus =
        runStatus === "error" ? "failed" : artifactsOk && patternsOk ? "passed" : "failed";

      // Build human-readable summary
      const summaryParts: string[] = [];
      summaryParts.push(`Session: ${runStatus}`);
      if (currentRun.outcome?.error) {
        summaryParts.push(`Error: ${currentRun.outcome.error}`);
      }
      if (artifactChecks.length > 0) {
        const found = artifactChecks.filter((a) => a.found).length;
        summaryParts.push(`Artifacts: ${found}/${artifactChecks.length} found`);
      }
      if (transcriptChecks.patternResults.length > 0) {
        const matched = transcriptChecks.patternResults.filter((p) => p.found).length;
        summaryParts.push(`Patterns: ${matched}/${transcriptChecks.patternResults.length} matched`);
      }

      return jsonResult({
        status: overallStatus,
        runId: currentRun.runId,
        sessionKey,
        runStatus,
        runtimeSeconds: Math.round(
          ((currentRun.endedAt ?? Date.now()) - (currentRun.startedAt ?? currentRun.createdAt)) /
            1000,
        ),
        checks: {
          artifacts: artifactChecks.length > 0 ? artifactChecks : undefined,
          patterns:
            transcriptChecks.patternResults.length > 0
              ? transcriptChecks.patternResults
              : undefined,
        },
        summary: summaryParts.join(". "),
        outcome: currentRun.outcome,
      });
    },
  };
}
