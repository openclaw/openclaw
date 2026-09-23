import type { createControlUiSessionFixtures } from "./control-ui-session-fixtures.ts";

// Serialized into the page alongside the session fixture owner. Keep runtime
// dependencies explicit: imported types disappear before toString() injection.
export function createControlUiMockResponses(
  input: {
    methodResponses: Record<string, unknown>;
    defaultAgentId: string;
    sessions: Pick<ReturnType<typeof createControlUiSessionFixtures>, "list" | "listResponse">;
    groupRenames: () => readonly { from: string; to: string | null }[];
  },
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  type BrowserMethodResponseCase = {
    match?: Record<string, unknown>;
    response?: unknown;
  };
  type BrowserMethodResponseCases = {
    cases?: BrowserMethodResponseCase[];
  };
  type BrowserMethodResponseSequence = {
    sequence?: unknown[];
  };
  const methodResponseSequenceIndexes = new Map<string, number>();
  const sessions = input.sessions;

  function valuesEqual(actual: unknown, expected: unknown): boolean {
    if (Object.is(actual, expected)) {
      return true;
    }
    if ((actual && typeof actual === "object") || (expected && typeof expected === "object")) {
      try {
        return JSON.stringify(actual) === JSON.stringify(expected);
      } catch {
        return false;
      }
    }
    return false;
  }

  function paramsMatch(params: unknown, match: Record<string, unknown> | undefined): boolean {
    if (!match) {
      return true;
    }
    const entries = Object.entries(match);
    if (entries.length === 0) {
      return true;
    }
    if (!isRecord(params)) {
      return false;
    }
    return entries.every(
      ([key, expected]) => Object.hasOwn(params, key) && valuesEqual(params[key], expected),
    );
  }

  function responseCases(value: unknown): BrowserMethodResponseCase[] | null {
    if (!isRecord(value)) {
      return null;
    }
    const maybeCases = (value as BrowserMethodResponseCases).cases;
    return Array.isArray(maybeCases) ? maybeCases : null;
  }

  function responseSequence(value: unknown): unknown[] | null {
    if (!isRecord(value)) {
      return null;
    }
    const maybeSequence = (value as BrowserMethodResponseSequence).sequence;
    return Array.isArray(maybeSequence) ? maybeSequence : null;
  }

  function configuredResponse(
    method: string,
    params: unknown,
    advanceSequence = true,
  ): { found: boolean; value?: unknown } {
    if (!Object.hasOwn(input.methodResponses, method)) {
      return { found: false };
    }
    const configured = input.methodResponses[method];
    const sequence = responseSequence(configured);
    if (sequence) {
      if (sequence.length === 0) {
        return { found: false };
      }
      const index = methodResponseSequenceIndexes.get(method) ?? 0;
      if (advanceSequence) {
        methodResponseSequenceIndexes.set(method, index + 1);
      }
      // Keep the final response stable so harmless UI retries remain deterministic.
      return { found: true, value: sequence[Math.min(index, sequence.length - 1)] };
    }
    const cases = responseCases(configured);
    if (!cases) {
      return { found: true, value: configured };
    }
    const matchingCase = cases.find((candidate) => paramsMatch(params, candidate.match));
    if (!matchingCase) {
      return { found: false };
    }
    return { found: true, value: matchingCase.response };
  }

  function scopedSearchResponse(
    params: Record<string, unknown>,
    response: Record<string, unknown>,
  ) {
    const scope = isRecord(params.scope) ? params.scope : {};
    // Explicit search snapshots model matches outside a bounded roster. Otherwise
    // reuse the fixture's list-case selection without issuing a browser list RPC.
    const configuredList = Array.isArray(response.sessions)
      ? { sessions: response.sessions }
      : configuredResponse("sessions.list", scope, false).value;
    const selected = sessions.listResponse(configuredList ?? { sessions: sessions.list() }, scope, {
      renames: input.groupRenames(),
      archiveFiltering: true,
    });
    const configuredAgents = configuredResponse("agents.list", {}, false).value;
    const agentIds = new Set(
      isRecord(configuredAgents) && Array.isArray(configuredAgents.agents)
        ? configuredAgents.agents.flatMap((agent) =>
            isRecord(agent) && typeof agent.id === "string" ? [agent.id] : [],
          )
        : [input.defaultAgentId],
    );
    const rows = new Map<string, Record<string, unknown> & { key: string }>();
    if (isRecord(selected) && Array.isArray(selected.sessions)) {
      for (const row of selected.sessions) {
        if (!isRecord(row) || typeof row.key !== "string") {
          continue;
        }
        const key = row.key;
        const agentId = typeof row.agentId === "string" ? row.agentId : (key.split(":")[1] ?? "");
        const cron = /^(?:agent:[^:]+:)?cron:/u.test(key);
        const actor = isRecord(row.createdActor) ? row.createdActor : null;
        const system =
          !cron &&
          (actor?.type === "system" ||
            ((row.createdVia === "run" || row.createdVia === "internal") &&
              actor?.type !== "human" &&
              ![row.label, row.displayName, row.subject].some(
                (value) => typeof value === "string" && value.trim(),
              )));
        if (
          (key === "global" && scope.includeGlobal !== true) ||
          (key === "unknown" && scope.includeUnknown !== true) ||
          (scope.agentId && key !== "global" && agentId !== scope.agentId) ||
          (scope.configuredAgentsOnly === true &&
            key.startsWith("agent:") &&
            !agentIds.has(agentId)) ||
          (scope.excludeSubagents === true &&
            (key.includes(":subagent:") ||
              (row.spawnedBy && !(typeof row.category === "string" && row.category.trim())))) ||
          (cron && (scope.excludeCron === true || key.includes(":run:"))) ||
          (scope.excludeSystem === true && system) ||
          (scope.boardFace && row.boardFace !== scope.boardFace) ||
          (typeof scope.activeMinutes === "number" &&
            (typeof row.updatedAt === "number" ? row.updatedAt : 0) <
              Date.now() - scope.activeMinutes * 60_000)
        ) {
          continue;
        }
        rows.set(key, { ...row, key });
      }
    }
    // Fixture hits are already query-ranked; membership must precede LIMIT so
    // excluded high-ranking hits cannot crowd a visible session out of the page.
    const hits = Array.isArray(response.results)
      ? response.results.filter(
          (hit): hit is Record<string, unknown> & { sessionKey: string } =>
            isRecord(hit) && typeof hit.sessionKey === "string" && rows.has(hit.sessionKey),
        )
      : [];
    const limit = typeof params.limit === "number" ? params.limit : 10;
    const results = hits.slice(0, limit);
    const matchedKeys = new Set(results.map((hit) => hit.sessionKey));
    return {
      ...response,
      results,
      sessions: [...rows.values()].filter((row) => matchedKeys.has(row.key)),
      ...(hits.length > limit ? { truncated: true } : {}),
    };
  }

  return {
    select: configuredResponse,
    cases: responseCases,
    sequence: responseSequence,
    matches: paramsMatch,
    search: scopedSearchResponse,
    resetSequence: (method: string) => methodResponseSequenceIndexes.delete(method),
  };
}
