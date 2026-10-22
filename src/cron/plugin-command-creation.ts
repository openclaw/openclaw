import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  type PluginCommandSchedule,
} from "./plugin-command-schedule.types.js";
import type { CronJobCreate, CronStoredJob } from "./types.js";

const TOKEN_FIELD = "_pluginCommandCreation";

type Creation = {
  token: string;
  envelope: PluginCommandSchedule;
  input: CronJobCreate;
  assertCurrent: () => void;
  consumed: boolean;
  committed?: { jobId: string; deadlineAtMs: number; maxRuns: number };
};
const creationScope = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginCommandScheduleCreation"),
  () => new AsyncLocalStorage<Creation>(),
);

/** Core-only custody accompanying the real native automations tool and cron.add handler. */
export async function withPluginCommandScheduleCreation(
  envelope: PluginCommandSchedule,
  input: CronJobCreate,
  assertCurrent: () => void,
  execute: () => Promise<unknown>,
) {
  const creation: Creation = {
    token: randomUUID(),
    envelope: structuredClone(envelope),
    input: structuredClone(input),
    assertCurrent,
    consumed: false,
  };
  return await creationScope.run(creation, async () => {
    assertCurrent();
    try {
      await execute();
    } catch (error) {
      // Optional post-effect hooks cannot take back accepted native schedule IDs.
      if (!creation.committed) {
        throw error;
      }
    }
    // A hook's return value cannot manufacture native scheduler acceptance.
    if (!creation.committed) {
      throw new Error("Native command schedule was not accepted.");
    }
    return creation.committed;
  });
}

/** Native tool transport only. Missing in-process custody refuses before any RPC/effect. */
export function attachPluginCommandCreation(method: string, params: unknown, inProcess: boolean) {
  const creation = creationScope.getStore();
  if (!creation) {
    return params;
  }
  creation.assertCurrent();
  if (method !== "cron.add" || !inProcess || creation.consumed) {
    throw new Error("Scheduled command creation requires its one local native cron.add call.");
  }
  const input = asOptionalRecord(params);
  if (!input) {
    throw new Error("Invalid native command schedule input.");
  }
  return { ...input, [TOKEN_FIELD]: creation.token };
}

/** Redeemed only by the normal authenticated cron.add producer, never from public arguments. */
export function readPluginCommandCreation(params: Record<string, unknown>) {
  const input = asOptionalRecord(params);
  const payload = asOptionalRecord(input?.payload);
  const token = input?.[TOKEN_FIELD];
  const creation = creationScope.getStore();
  if (token === undefined) {
    if (creation || payload?.message === PLUGIN_COMMAND_SCHEDULE_MESSAGE) {
      throw new Error("Scheduled command is missing its host creation custody.");
    }
    return { params, creation: undefined };
  }
  if (!creation || creation.consumed || token !== creation.token || !input) {
    throw new Error("Invalid scheduled command creation custody.");
  }
  creation.assertCurrent();
  const { [TOKEN_FIELD]: _token, ...job } = input;
  const expected = creation.input;
  const cap = payload?.toolsAllow;
  if (
    job.agentId !== expected.agentId ||
    job.sessionKey !== expected.sessionKey ||
    job.sessionTarget !== expected.sessionTarget ||
    job.declarationKey !== expected.declarationKey ||
    job.name !== expected.name ||
    job.deleteAfterRun !== expected.deleteAfterRun ||
    !isDeepStrictEqual(job.schedule, expected.schedule) ||
    !isDeepStrictEqual(job.delivery, { mode: "none" }) ||
    payload?.kind !== "agentTurn" ||
    payload.message !== PLUGIN_COMMAND_SCHEDULE_MESSAGE ||
    Object.keys(payload).some((key) => !["kind", "message", "toolsAllow"].includes(key)) ||
    !Array.isArray(cap) ||
    !cap.every(
      (name: unknown): name is string =>
        typeof name === "string" && creation.envelope.toolsAllow.includes(name),
    ) ||
    !cap.includes("sessions_spawn") ||
    !cap.includes("agents_wait")
  ) {
    throw new Error("Native command schedule changed after requester admission.");
  }
  // The normal native creator may narrow the tool ceiling, never enlarge it.
  creation.envelope.toolsAllow = [...new Set(cap)];
  creation.consumed = true;
  return {
    params: job,
    creation: {
      envelope: creation.envelope,
      assertCurrent: creation.assertCurrent,
      record(stored: CronStoredJob) {
        if (!stored.pluginCommand || !isDeepStrictEqual(stored.pluginCommand, creation.envelope)) {
          throw new Error("Native schedule did not retain its command ownership.");
        }
        creation.committed = {
          jobId: stored.id,
          deadlineAtMs: creation.envelope.deadlineAtMs,
          maxRuns: creation.envelope.maxRuns,
        };
      },
    },
  };
}
