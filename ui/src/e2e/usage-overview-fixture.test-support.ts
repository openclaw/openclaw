import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type { SessionsUsageParams } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionCostSummary } from "../../../src/infra/session-cost-usage.types.js";
import { buildUsageOverview, mergeUsageOverviews } from "../../../src/shared/usage-overview.js";
import type { SessionUsageEntry, SessionsUsageResult } from "../../../src/shared/usage-types.js";
import type {
  ControlUiMockGateway,
  MockGatewayControls,
} from "../test-helpers/control-ui-e2e-contract.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

/** Exercise server-owned filtering without copying that policy into the browser fixture. */
export async function installUsageOverviewGateway(
  page: Page,
  scenario: Parameters<typeof installMockGateway>[1],
): Promise<MockGatewayControls> {
  let configured = scenario?.methodResponses?.["sessions.usage"];
  let sequenceIndex = 0;
  function selectResponse(params: SessionsUsageParams) {
    if (!isRecord(configured)) {
      return configured;
    }
    if (Array.isArray(configured.sequence)) {
      return configured.sequence[Math.min(sequenceIndex++, configured.sequence.length - 1)];
    }
    if (Array.isArray(configured.cases)) {
      return configured.cases.find((candidate: { match?: Record<string, unknown> }) =>
        Object.entries(candidate.match ?? {}).every(
          ([key, value]) =>
            JSON.stringify(params[key as keyof SessionsUsageParams]) === JSON.stringify(value),
        ),
      )?.response;
    }
    return configured;
  }
  function project(value: unknown, params: SessionsUsageParams, browserTimeZone: string) {
    if (!isRecord(value) || !Array.isArray(value.sessions) || params.projection !== "overview") {
      return value;
    }
    const response = value as SessionsUsageResult;
    const summaries = response.sessions.map((session): SessionCostSummary | null => {
      const usage = session.usage;
      if (!usage) {
        return null;
      }
      return {
        ...usage,
        firstActivity:
          usage.firstActivity ??
          (usage.totalTokens || usage.messageCounts?.total
            ? (session.updatedAt ?? response.updatedAt)
            : undefined),
      };
    });
    const options = { ...params, limit: 50 };
    const slice = buildUsageOverview({
      sessions: response.sessions.map(({ usage: _usage, ...session }: SessionUsageEntry) => ({
        ...session,
        agentId: session.agentId ?? "main",
        instances: [{ sessionFile: session.key }],
      })),
      summaries,
      options,
      dayBucket:
        params.mode === "utc"
          ? { mode: "utc-offset", utcOffsetMinutes: 0 }
          : { mode: "time-zone", timeZone: params.timeZone ?? browserTimeZone },
    });
    const projected = mergeUsageOverviews([slice], options);
    const hasPopulationFilter = Boolean(
      params.query?.trim() ||
      params.selectedDays?.length ||
      params.selectedHours?.length ||
      params.selectedSessions?.length,
    );
    return {
      ...response,
      ...projected,
      ...(!hasPopulationFilter ? { totals: response.totals, aggregates: response.aggregates } : {}),
    };
  }
  await page.exposeFunction(
    "openclawUsageOverviewFixture",
    (params: SessionsUsageParams, browserTimeZone: string) =>
      project(selectResponse(params), params, browserTimeZone),
  );
  await page.addInitScript(() => {
    type FixtureWindow = Window & {
      openclawControlUiE2eGateway?: ControlUiMockGateway;
      openclawUsageOverviewFixture: (params: unknown, timeZone: string) => Promise<unknown>;
    };
    const owner = window as FixtureWindow;
    const attach = (gateway: ControlUiMockGateway) =>
      gateway.setRequestHandler("sessions.usage", ({ params, respond }) => {
        void owner
          .openclawUsageOverviewFixture(params, Intl.DateTimeFormat().resolvedOptions().timeZone)
          .then(respond, (error: unknown) => {
            respond({ __mockError: { code: "INTERNAL_ERROR", message: String(error) } });
          });
      });
    let gateway = owner.openclawControlUiE2eGateway;
    if (gateway) {
      attach(gateway);
    }
    Object.defineProperty(owner, "openclawControlUiE2eGateway", {
      configurable: true,
      get: () => gateway,
      set: (next: ControlUiMockGateway) => {
        gateway = next;
        attach(next);
      },
    });
  });
  const gateway = await installMockGateway(page, scenario);
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
      if (method === "sessions.usage" && payload !== undefined) {
        const request = (await gateway.getRequests(method, options?.match, options)).at(-1);
        const browserTimeZone = await page.evaluate(
          () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        return gateway.resolveDeferred(
          method,
          project(payload, (request?.params ?? {}) as SessionsUsageParams, browserTimeZone),
          options,
        );
      }
      await gateway.resolveDeferred(method, payload, options);
    },
  };
}
