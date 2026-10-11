import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "../../ui/src/lib/session-pr-automation-spec.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import {
  SESSION,
  SESSION_ID,
  stateDir,
  createCronFixture,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService, type CronEvent } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

export const prAutomationSessionAccessor = await vi.importActual<
  typeof import("../config/sessions/session-accessor.js")
>("../config/sessions/session-accessor.js");

// This synthetic model consumes only the serialized recipe target. It does not
// evaluate prose, reviews, CI, or GitHub authority and cannot prove autonomous merging.
export function readPrAutomationRecipeTarget(prompt: string) {
  const line = expectDefined(
    prompt.split("\n").find((value) => value.includes("for this exact target: ")),
    "recipe target line",
  );
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  const target = asRecord(JSON.parse(line.slice(start, end + 1)));
  if (
    typeof target.owner !== "string" ||
    typeof target.repo !== "string" ||
    typeof target.number !== "number" ||
    typeof target.sessionKey !== "string"
  ) {
    throw new Error("Scheduled recipe lost its PR target");
  }
  return {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    sessionKey: target.sessionKey,
    sessionId: typeof target.sessionId === "string" ? target.sessionId : undefined,
  };
}

export async function createPrAutomationFixture(
  option: CiAutomationOption,
  executionDeps: (
    config: OpenClawConfig,
  ) => Pick<CronServiceDeps, "runIsolatedAgentJob" | "runSessionEvent">,
  configDefaults?: OpenClawConfig["agents"],
) {
  const config = {
    agents: {
      ...configDefaults,
      defaults: { skipBootstrap: true, workspace: stateDir, ...configDefaults?.defaults },
      entries: { main: { workspace: stateDir } },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
  setRuntimeConfigSnapshot(config);
  const seed = async (sessionId: string) =>
    await prAutomationSessionAccessor.replaceSessionEntry(
      { agentId: "main", sessionKey: SESSION },
      {
        sessionId,
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
      },
    );
  await seed(SESSION_ID);
  const creator = createCronFixture(undefined, config);
  const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
  const target: CiAutomationTarget = {
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    owner: "fixture-org",
    repo: "fixture-repo",
    number: 41,
  };
  const add = async (selected: CiAutomationTarget) => {
    const definition = { ...ciAutomationJobSpec(selected, option), enabled: false };
    const respond = vi.fn();
    await expectDefined(
      cronHandlers["cron.add"],
      "cron.add",
    )({
      req: { type: "req", id: "recipe-create", method: "cron.add", params: definition },
      params: definition,
      respond,
      context: creator.context,
      client,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    return expectDefined(
      (await creator.read()).find((job) => job.declarationKey === definition.declarationKey),
      "persisted recipe",
    );
  };
  const selected = await add(target);
  const other = await add({ ...target, number: 42 });
  expect(other.id).not.toBe(selected.id);
  const clock = createGatewaySchedulerClock(Date.now());
  let finished = createDeferredCore<CronEvent>();
  const work = new AsyncWorkScope();
  const { runIsolatedAgentJob, runSessionEvent } = executionDeps(config);
  const execution = new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    nowMs: clock.clock.now,
    storePath: path.join(stateDir, "cron", "jobs.json"),
    cronEnabled: true,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    onEvent: (event) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
    runIsolatedAgentJob: (request) => work.track(() => runIsolatedAgentJob(request)),
    runSessionEvent: runSessionEvent
      ? (request) => work.track(() => runSessionEvent(request))
      : undefined,
  });
  // Reload through a distinct scheduler owner rather than reuse cron.add's memory.
  await execution.start();
  expect((await execution.list({ includeDisabled: true })).map((job) => job.id).toSorted()).toEqual(
    [selected.id, other.id].toSorted(),
  );
  const tick = async () => {
    finished = createDeferredCore<CronEvent>();
    await clock.advanceBy(300_000);
    return await finished.promise;
  };
  const stop = async () => {
    execution.stop();
    await execution.waitForIdle();
    // Cancellation publishes its result before the core finishes touching session state.
    await work.drain();
  };
  return { creator, client, target, add, selected, other, execution, seed, tick, stop };
}
