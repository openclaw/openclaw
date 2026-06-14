/**
 * Gateway sessions.describe agent-scope tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { testState } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsTestHarness();

async function writeSelectedGlobalStores(params: {
  mainStorePath: string;
  workStorePath: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.mainStorePath), { recursive: true });
  await fs.mkdir(path.dirname(params.workStorePath), { recursive: true });
  await fs.writeFile(
    params.mainStorePath,
    JSON.stringify({ global: sessionStoreEntry("sess-main-global") }, null, 2),
  );
  await fs.writeFile(
    params.workStorePath,
    JSON.stringify({ global: sessionStoreEntry("sess-work-global") }, null, 2),
  );
}

function clearSessionTestState(): void {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
}

type DescribeResult = { session: { sessionId?: string } | null };

test("sessions.describe scopes a selected global session to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSelectedGlobalStores({ mainStorePath, workStorePath });

  const described = await directSessionReq<DescribeResult>("sessions.describe", {
    key: "global",
    agentId: "work",
  });
  expect(described.ok).toBe(true);
  expect(described.payload?.session?.sessionId).toBe("sess-work-global");

  // Without an explicit agentId the global session resolves through the default store agent.
  const describedDefault = await directSessionReq<DescribeResult>("sessions.describe", {
    key: "global",
  });
  expect(describedDefault.ok).toBe(true);
  expect(describedDefault.payload?.session?.sessionId).toBe("sess-main-global");

  clearSessionTestState();
});

test("sessions.describe rejects an unknown agentId", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSelectedGlobalStores({ mainStorePath, workStorePath });

  const described = await directSessionReq("sessions.describe", {
    key: "global",
    agentId: "ghost",
  });
  expect(described.ok).toBe(false);
  expect(described.error?.message).toMatch(/Unknown agent id/);

  clearSessionTestState();
});
