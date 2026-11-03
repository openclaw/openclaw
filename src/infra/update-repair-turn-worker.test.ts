import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as sqliteSnapshotSource from "./sqlite-snapshot-source.js";
import type { UpdateRepairTurnMessage } from "./update-repair-protocol.js";
import { runDelegatedUpdateRepairTurn } from "./update-repair-turn-worker.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

const runtime = vi.hoisted(() => ({
  withUpdateRepairEnvironment: vi.fn((_target, operation) => operation()),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
// Native process binding has its own real-child proof. This suite exercises the
// worker's requester checks with inert inference, never tools or child processes.
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  withDelegatedUpdateCommandExecutor: vi.fn(async (_grant, _runId, _root, operation) =>
    operation({ assertCurrent() {} }),
  ),
  assertUpdateRequesterContinuationOwner: () => {
    throw new Error("Requester continuation requires its admitted Gateway update owner.");
  },
}));
vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: async () => {},
}));
vi.mock("./update-repair-agent.runtime.js", () => runtime);

const requester = { channel: "synthetic", senderId: "owner" };
const route = { model: "repair", provider: "fixture" };
const selected = { ok: true, route, modelFallbacks: [] };
const completed = { toolCalls: 0, envelope: { ...route, final: "No changes", status: "ok" } };
const connected = Object.getOwnPropertyDescriptor(process, "connected");
beforeEach(() => {
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  vi.clearAllMocks();
  runtime.withUpdateRepairEnvironment
    .mockReset()
    .mockImplementation((_target, operation) => operation());
  runtime.prepareUpdateRepairInference.mockReset();
  runtime.runUpdateRepairTurn.mockReset();
  runtime.prepareUpdateRepairInference.mockResolvedValue(selected);
  runtime.runUpdateRepairTurn.mockImplementation(async ({ isCurrent }) => {
    isCurrent();
    return completed;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (connected) {
    Object.defineProperty(process, "connected", connected);
  } else {
    Reflect.deleteProperty(process, "connected");
  }
});

type Requester = UpdateRepairTurnMessage["requester"];
type AuthorityCase = [
  name: string,
  trigger: Parameters<typeof createUpdateRun>[0]["trigger"],
  recorded?: Requester,
  sent?: Requester,
  change?: "origin" | "policy",
  refusal?: string,
];
const revoked = "requester-revoked";
const profile = { ...requester, authorizationSource: "profile:synthetic" };
const other = { ...requester, senderId: "other-owner" };
const webchat = { channel: "webchat" };
const operator = { senderId: "operator" };
const continuationRefusal = "Requester continuation requires its admitted Gateway update owner.";

function withRun(
  trigger: AuthorityCase[1],
  recorded: Requester,
  operation: (state: OpenClawTestState, runId: string) => Promise<void>,
) {
  return withOpenClawTestState({ layout: "home" }, async (state) => {
    await state.writeConfig({ commands: { ownerAllowFrom: ["owner", "other-owner"] } });
    const run = createUpdateRun({ trigger, origin: { requester: recorded } }, { env: state.env });
    recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
    await operation(state, run.runId);
  });
}

it.each<AuthorityCase>([
  ["omitted requester", "chat", requester, undefined, undefined, revoked],
  ["substituted requester", "chat", requester, other, undefined, revoked],
  ["requester added to CLI", "cli", undefined, requester, undefined, revoked],
  ["chat owner", "chat", requester, requester],
  ["local CLI", "cli"],
  ["internal channel", "control-ui", webchat, webchat],
  ["channel-less operator", "api", operator, operator],
  ["changed origin", "chat", requester, requester, "origin", revoked],
  ["changed policy", "chat", requester, requester, "policy", revoked],
  ["unowned profile", "chat", profile, profile, undefined, continuationRefusal],
])("checks %s before effects", async (_name, trigger, recorded, sent, change, refusal) => {
  await withRun(trigger, recorded, async (state, runId) => {
    if (change) {
      runtime.prepareUpdateRepairInference.mockImplementationOnce(async () => {
        if (change === "origin") {
          recordUpdateRunPhase(
            runId,
            "repairing",
            { origin: { requester: other } },
            { env: state.env },
          );
        } else {
          await state.writeConfig({ commands: { ownerAllowFrom: ["other-owner"] } });
        }
        return selected;
      });
    }
    const onRoute = vi.fn();
    const result = await runTurn(runId, state, sent, onRoute);
    if (refusal) {
      expect(result).toMatchObject({ status: "aborted", reason: refusal });
      expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
      expect(onRoute).not.toHaveBeenCalled();
      if (!change) {
        expect(runtime.prepareUpdateRepairInference).not.toHaveBeenCalled();
      }
    } else {
      expect(result).toMatchObject({ status: "completed", toolCalls: 0 });
    }
  });
});

it("keeps in-turn liveness cheap and refuses revoked authority before tool effects", async () => {
  await withRun("chat", requester, async (state, runId) => {
    await state.writeConfig({ commands: { ownerAllowFrom: ["owner"] } });
    // Like the delegated worker, read the updater's ledger without holding its writer.
    await closeOpenClawStateDatabaseAsync();
    const snapshots = vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync");
    runtime.runUpdateRepairTurn.mockImplementationOnce(async ({ isCurrent, isLive }) => {
      snapshots.mockClear();
      for (let check = 0; check < 20; check += 1) {
        expect(isLive()).toBe(true);
      }
      expect(snapshots).not.toHaveBeenCalled();
      expect(isCurrent()).toBe(true);
      await state.writeConfig({ commands: { ownerAllowFrom: ["other-owner"] } });
      // Tool admission uses the full predicate, so a revoked owner stops the next effect.
      expect(isCurrent).toThrow(revoked);
      return completed;
    });
    const result = await runTurn(runId, state, requester);
    expect(result).toMatchObject({ status: "aborted", reason: revoked });
    expect(snapshots).toHaveBeenCalled();
  });
});
it.each([-5_000, 5_000])(
  "preserves the delegated budget and deadline after a %ims wall-clock step",
  async (jump) => {
    await withRun("chat", requester, async (state, runId) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      runtime.withUpdateRepairEnvironment.mockImplementationOnce(async (_target, operation) => {
        vi.advanceTimersByTime(1_000);
        vi.setSystemTime(Date.now() + jump);
        return operation();
      });
      runtime.prepareUpdateRepairInference.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(1_000);
        return selected;
      });
      runtime.runUpdateRepairTurn.mockImplementationOnce(async ({ timeoutMs, signal }) => {
        expect(timeoutMs).toBe(28_000);
        await vi.advanceTimersByTimeAsync(27_999);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        return completed;
      });
      expect(await runTurn(runId, state, requester)).toMatchObject({
        status: "completed",
        timedOut: true,
      });
      expect(runtime.prepareUpdateRepairInference).toHaveBeenCalledWith(expect.anything(), 29_000);
    });
  },
);

function runTurn(
  runId: string,
  state: OpenClawTestState,
  admitted: UpdateRepairTurnMessage["requester"],
  onRoute = vi.fn(),
) {
  const message: UpdateRepairTurnMessage = {
    type: "turn",
    runId,
    requester: admitted,
    executor: {},
    target: { ...state, installRoot: state.workspaceDir },
    prompt: "Inspect the synthetic fixture.",
    wallClockMs: 30_000,
    timeoutMs: 30_000,
    maxToolCalls: 0,
  };
  return runDelegatedUpdateRepairTurn(message, state.env, new AbortController().signal, onRoute);
}
