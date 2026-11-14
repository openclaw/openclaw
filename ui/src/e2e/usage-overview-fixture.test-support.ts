import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type { SessionsUsageParams } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { buildUsageOverview } from "../../../src/shared/usage-overview.js";
import type { SessionUsageEntry, SessionsUsageResult } from "../../../src/shared/usage-types.js";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e-contract.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

/** Exercise server-owned filtering without copying that policy into the browser fixture. */
export async function installUsageOverviewGateway(
  page: Page,
  scenario: Parameters<typeof installMockGateway>[1],
): Promise<MockGatewayControls> {
  let configured = scenario?.methodResponses?.["sessions.usage"];
  let sequenceIndex = 0;
  function selectResponse(params: SessionsUsageParams) {
    const { sequence, cases } = isRecord(configured) ? configured : {};
    if (Array.isArray(sequence)) {
      return sequence[Math.min(sequenceIndex++, sequence.length - 1)];
    }
    if (Array.isArray(cases)) {
      return cases.find((candidate: { match?: Record<string, unknown> }) =>
        Object.entries(candidate.match ?? {}).every(
          ([key, value]) =>
            JSON.stringify(params[key as keyof SessionsUsageParams]) === JSON.stringify(value),
        ),
      )?.response;
    }
    return configured;
  }
  function project(value: unknown, params: SessionsUsageParams, browserTimeZone: string) {
    if (!isRecord(value) || !Array.isArray(value.sessions)) {
      return value;
    }
    const response = value as SessionsUsageResult;
    if (params.key) {
      return { ...response, sessions: response.sessions.filter((row) => row.key === params.key) };
    }
    if (params.projection !== "overview") {
      return value;
    }
    const rows = response.sessions.map((session): SessionUsageEntry => {
      const usage = session.usage;
      const firstActivity =
        usage?.firstActivity ??
        (usage?.totalTokens || usage?.messageCounts?.total
          ? (session.updatedAt ?? response.updatedAt)
          : undefined);
      return {
        ...session,
        agentId: session.agentId ?? "main",
        usage: usage ? { ...usage, firstActivity } : null,
        ...(!usage ? { computing: true } : {}),
      };
    });
    const projected = buildUsageOverview({
      rows,
      options: { ...params, limit: 50 },
      dayBucket:
        params.mode === "utc"
          ? { mode: "utc-offset", utcOffsetMinutes: 0 }
          : { mode: "time-zone", timeZone: params.timeZone ?? browserTimeZone },
    });
    const hasPopulationFilter =
      params.query?.trim() ||
      [params.selectedDays, params.selectedHours, params.selectedSessions].some(
        (items) => items?.length,
      );
    return {
      ...response,
      ...projected,
      ...(!hasPopulationFilter ? { totals: response.totals, aggregates: response.aggregates } : {}),
    };
  }
  const browserTimeZone = () =>
    page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const gateway = await installMockGateway(page, scenario, {
    requestHandlers: {
      "sessions.usage": async (raw) => {
        try {
          const params = raw as SessionsUsageParams;
          return project(selectResponse(params), params, await browserTimeZone());
        } catch (error) {
          return { __mockError: { code: "INTERNAL_ERROR", message: String(error) } };
        }
      },
    },
  });
  return {
    ...gateway,
    async setMethodResponse(method, payload) {
      if (method === "sessions.usage") {
        configured = payload;
        sequenceIndex = 0;
      }
      await gateway.setMethodResponse(method, payload);
    },
    async resolveDeferred(method, payload, options) {
      let resolved = payload;
      if (method === "sessions.usage" && payload !== undefined) {
        const request = (await gateway.getRequests(method, options?.match, options)).at(-1);
        resolved = project(
          payload,
          (request?.params ?? {}) as SessionsUsageParams,
          await browserTimeZone(),
        );
      }
      await gateway.resolveDeferred(method, resolved, options);
    },
  };
}
