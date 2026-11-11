import { expect, it, vi } from "vitest";
import type { SessionTranscriptTurnMutation } from "./goals-operations.types.js";
import {
  assertSessionTurnAcceptedResult,
  prepareSessionTurnRoutingDependencies,
} from "./session-turn-predicate.js";

const loaded = vi.hoisted(() => ({ lookup: vi.fn(), read: vi.fn() }));

// mock-isolation: Observe module evaluation without loading host Gateway discovery.
vi.mock("../../gateway/session-utils-store-lookup.js", () => {
  loaded.lookup();
  return { prepareGatewaySessionStoreTargetLookup: vi.fn() };
});
// mock-isolation: Observe module evaluation without opening host session stores.
vi.mock("../../gateway/session-utils-store-read.js", () => {
  loaded.read();
  return { readGatewaySessionStore: vi.fn() };
});
// mock-isolation: The accepted-result policy has a standalone owner, not the lifecycle facade.
vi.mock("./lifecycle.js", () => {
  throw new Error("Turn predicates must not load host lifecycle operations");
});

it("loads routing only when a later turn needs it, retaining accepted-result checks", async () => {
  await prepareSessionTurnRoutingDependencies(undefined);
  const options = {
    sessionFile: "agent:main:predicate",
    expectedSessionId: "session",
    messages: [],
    acceptedResultGuard: { expectedWriterRunId: "run", errorMessage: "writer changed" },
  };
  const entry = { sessionId: "session", updatedAt: 1, activeWriterRunId: "run" };
  expect(() => assertSessionTurnAcceptedResult(options.sessionFile, entry, options)).not.toThrow();
  expect(() =>
    assertSessionTurnAcceptedResult(
      options.sessionFile,
      { ...entry, sessionId: "rebound" },
      options,
    ),
  ).toThrow(/changed while starting work/);
  expect(() =>
    assertSessionTurnAcceptedResult(
      options.sessionFile,
      { ...entry, activeWriterRunId: "other" },
      options,
    ),
  ).toThrow("writer changed");
  expect(loaded.lookup).not.toHaveBeenCalled();
  expect(loaded.read).not.toHaveBeenCalled();

  const predicate: NonNullable<SessionTranscriptTurnMutation["routingPredicate"]> = {
    config: {},
    key: options.sessionFile,
    agentId: "main",
    canonicalKey: options.sessionFile,
    storePath: "/synthetic/openclaw-agent.sqlite",
  };
  await prepareSessionTurnRoutingDependencies(predicate);
  await prepareSessionTurnRoutingDependencies(undefined);
  await prepareSessionTurnRoutingDependencies(predicate);
  expect(loaded.lookup).toHaveBeenCalledOnce();
  expect(loaded.read).toHaveBeenCalledOnce();
});
