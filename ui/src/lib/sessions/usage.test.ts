import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { requestSessionUsage, type SessionUsageQuery } from "./usage.ts";

const dates = { startDate: "2026-07-01", endDate: "2026-07-28" };
const query = { ...dates, scope: "family", timeZone: "utc" } as const;
const expected = { ...dates, mode: "utc", groupBy: "family", includeContextWeight: false };
const gateway = () => {
  const result = { sessions: [] };
  const request = createGatewayRequestMock().mockResolvedValue(result);
  return { request, client: createTestGatewayClient(request), result };
};

describe("requestSessionUsage", () => {
  afterEach(() => vi.restoreAllMocks());
  it("sends the browser IANA timezone with the current UTC offset in local mode", async () => {
    const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...resolvedOptions,
      timeZone: "Europe/Vienna",
    });
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);

    const { client, request } = gateway();
    await requestSessionUsage(client, { ...query, timeZone: "local" });
    expect(request).toHaveBeenCalledWith(
      "sessions.usage",
      expect.objectContaining({
        mode: "specific",
        timeZone: "Europe/Vienna",
        utcOffset: "UTC+2",
      }),
    );
  });
  it.each([
    { key: "agent:main:detail", agentId: undefined },
    { key: "global", agentId: "research" },
  ])("scopes selected context for $key without an all-agent request", async ({ key, agentId }) => {
    const { client, request } = gateway();
    const signal = new AbortController().signal;
    await requestSessionUsage(
      client,
      { ...query, agentId },
      { key, includeContextWeight: true, signal },
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.usage",
      {
        ...expected,
        key,
        limit: 1,
        includeContextWeight: true,
        ...(agentId ? { agentId } : {}),
      },
      { signal },
    );
  });
  it("requests canonical family grouping", async () => {
    const { client, request, result } = gateway();
    await expect(requestSessionUsage(client, query)).resolves.toBe(result);
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      ...expected,
      agentScope: "all",
      limit: 1000,
    });
  });

  it("requests a bounded overview with server filter and page ownership", async () => {
    const { client, request } = gateway();
    const filters = {
      query: "provider:openai",
      selectedDays: ["2026-07-14"],
      selectedHours: [12],
      selectedSessions: ["agent:main:chosen"],
      recentKeys: ["agent:main:chosen"],
      offset: 50,
      sort: "cost",
      sortDirection: "asc",
    } satisfies Partial<SessionUsageQuery>;
    const expectedFilters = structuredClone(filters);
    await requestSessionUsage(client, { ...query, ...filters }, { projection: "overview" });
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      ...expected,
      ...expectedFilters,
      agentScope: "all",
      projection: "overview",
      limit: 50,
    });
  });

  it("surfaces a rejected request without retrying an older Gateway shape", async () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid sessions.usage params: at root: unexpected property 'timeZone'",
    });
    const { client, request } = gateway();
    request.mockRejectedValue(error);

    await expect(
      requestSessionUsage(client, { ...query, scope: "instance", timeZone: "local" }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
  });
});
