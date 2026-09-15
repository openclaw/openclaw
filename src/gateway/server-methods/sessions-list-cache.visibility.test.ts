import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { listSessions, requestContext, seedSessions } from "./sessions-read-cache.test-support.js";

it("keeps completed session lists isolated by internal operator identity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    const request = { agentId: "main", archived: "all" as const, limit: 100 };
    const owner = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "operator", profileId: "owner@example.com" },
    });
    const viewer = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "operator", profileId: "viewer@example.com" },
    });
    const expected = await listSessions({
      client: viewer,
      context: requestContext(config),
      request,
    });
    expect(expected.sessions.map((row) => row.key)).not.toContain("agent:main:draft");

    const context = requestContext(config);
    const owned = await listSessions({ client: owner, context, request });
    expect(owned.sessions.map((row) => row.key)).toContain("agent:main:draft");
    const viewed = await listSessions({ client: viewer, context, request });
    expect(viewed.sessions.map((row) => row.key)).toEqual(expected.sessions.map((row) => row.key));
  });
});
