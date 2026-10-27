// @vitest-environment node
import { expect, it, onTestFinished } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../sessions/session-capability.test-support.ts";
import type { SessionCapability } from "../sessions/session-capability.ts";
import { sessionProgressTargetQuery } from "../sessions/session-requests.ts";
import { projectSessionProgressRoster } from "./session-progress-roster.ts";

async function observeAndReleaseRoster(sessions: SessionCapability) {
  const query = sessionProgressTargetQuery("main");
  const projection = projectSessionProgressRoster(sessions, "main");
  const release = projection.subscribe(() => {});
  onTestFinished(release);
  await sessions.refreshList(query);

  const retired = new WeakRef(sessions.listSnapshot(query));
  expect(retired.deref()?.result?.sessions).toHaveLength(1);
  release();
  expect(sessions.listSnapshot(query).result).toBeNull();
  return { projection, retired };
}

it("releases an unobserved roster while its session capability stays alive", async () => {
  const client = createTestGatewayClient(async () =>
    sessionsResult([
      {
        key: "agent:main:progress-target",
        sessionId: "progress-target",
        kind: "direct",
        updatedAt: 1,
      },
    ]),
  );
  const { sessions } = createSessionCapabilityHarness(client.request.bind(client));
  const { projection, retired } = await observeAndReleaseRoster(sessions);
  const control = new WeakRef({ unowned: true });
  await collectGarbageForTest();

  expect(control.deref()).toBeUndefined();
  expect(retired.deref()).toBeUndefined();
  expect(projectSessionProgressRoster(sessions, "main")).toBe(projection);
  expect(sessions.captureConnectionScope()).not.toBeNull();
});
