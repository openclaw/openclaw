/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import { flushMockTimers as flush } from "./mock-gateway-page.test-support.ts";

it("scopes configured search hits before limiting and returns only matched snapshots", async ({
  connect,
}) => {
  const rows = [
    { key: "agent:main:archived", archived: true },
    { key: "agent:other:outside" },
    { key: "agent:retired:outside" },
    { key: "global" },
    { key: "unknown" },
    { key: "agent:main:subagent:child" },
    { key: "agent:main:controlled", spawnedBy: "agent:main:parent" },
    { key: "agent:main:cron:job" },
    { key: "agent:main:probe", createdActor: { type: "system" } },
    { key: "agent:main:visible", label: "Visible match" },
    { key: "agent:main:later", label: "Later match" },
  ];
  const hits = rows.map((row, index) => ({
    sessionKey: row.key,
    sessionId: "retained-transcript",
    messageId: String(index),
    role: "assistant",
    score: rows.length - index,
    timestamp: 1,
    snippet: "needle",
  }));
  const { request, controls } = await connect({
    methodResponses: {
      "agents.list": { agents: [{ id: "main" }, { id: "other" }] },
      "sessions.list": { sessions: rows },
      "sessions.search": { results: hits, indexing: true, archivedTranscriptsExcluded: 2 },
    },
  });
  const scope = {
    agentId: "main",
    includeGlobal: false,
    includeUnknown: false,
    configuredAgentsOnly: true,
    excludeSubagents: true,
    excludeCron: true,
    excludeSystem: true,
  };
  const params = { query: "needle", limit: 1, scope };
  expect((await request("sessions.search", params)).payload).toEqual({
    results: [hits[9]],
    sessions: [expect.objectContaining(rows[9])],
    indexing: true,
    truncated: true,
    archivedTranscriptsExcluded: 2,
  });
  const { agentId: _agentId, ...allAgents } = scope;
  expect(
    (await request("sessions.search", { ...params, scope: allAgents })).payload.results,
  ).toEqual([hits[1]]);
  const onlyArchived = await request("sessions.search", {
    ...params,
    scope: { ...scope, archived: true },
  });
  expect(onlyArchived.payload.results).toEqual([hits[0]]);
  expect(onlyArchived.payload).not.toHaveProperty("truncated");

  await request("sessions.patch", { key: "agent:main:visible", archived: true });
  expect((await request("sessions.search", params)).payload.results).toEqual([hits[10]]);
  controls.setMethodResponse("sessions.search", { results: [] });
  expect((await request("sessions.search", params)).payload).toEqual({ results: [], sessions: [] });
});

it("uses scoped list cases without consuming list pages and preserves explicit deferred snapshots", async ({
  connect,
}) => {
  const parent = "agent:main:parent";
  const child = { key: "agent:main:child", parentSessionKey: parent, label: "Child" };
  const unrelated = { key: "agent:main:unrelated" };
  const hit = {
    sessionKey: child.key,
    sessionId: "child-transcript",
    messageId: "child-message",
    role: "user",
    score: 1,
    timestamp: 1,
    snippet: "needle",
  };
  const firstPage = { sessions: [unrelated], offset: 0, hasMore: true, nextOffset: 1 };
  const lastPage = { sessions: [], offset: 1, hasMore: false };
  const { request, controls, send, response } = await connect({
    sessions: [child, unrelated],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: parent }, response: { sessions: [unrelated, child] } },
          { response: firstPage },
        ],
      },
      "sessions.search": { results: [hit] },
    },
  });
  const params = { query: "needle", limit: 25, scope: { spawnedBy: parent } };
  expect((await request("sessions.search", params)).payload).toEqual({
    results: [hit],
    sessions: [expect.objectContaining(child)],
  });
  controls.setMethodResponse("sessions.list", { sequence: [firstPage, lastPage] });
  expect((await request("sessions.search", params)).payload).toEqual({ results: [], sessions: [] });
  expect((await request("sessions.list")).payload).toMatchObject(firstPage);
  expect((await request("sessions.list")).payload).toMatchObject(lastPage);

  controls.deferNext("sessions.search");
  const pending = await send("sessions.search", params);
  controls.resolveDeferred("sessions.search", { results: [hit], sessions: [child] });
  await flush();
  expect(response(pending)?.payload).toEqual({
    results: [hit],
    sessions: [expect.objectContaining(child)],
  });
  controls.setMethodResponse("sessions.search", {
    __mockError: { code: "FORBIDDEN", message: "Search denied" },
  });
  expect(await request("sessions.search", params)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "Search denied" },
  });
});
