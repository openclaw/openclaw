import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
const selected = {
  ok: true,
  route: { model: "repair", provider: "fixture" },
  modelFallbacks: [],
};
const connected = Object.getOwnPropertyDescriptor(process, "connected");
beforeEach(() => {
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  vi.clearAllMocks();
  runtime.prepareUpdateRepairInference.mockResolvedValue(selected);
  runtime.runUpdateRepairTurn.mockImplementation(async ({ isCurrent }) => {
    isCurrent();
    return {
      toolCalls: 0,
      envelope: { model: "repair", provider: "fixture", final: "No changes", status: "ok" },
    };
  });
});
afterEach(() => {
  if (connected) {
    Object.defineProperty(process, "connected", connected);
  } else {
    Reflect.deleteProperty(process, "connected");
  }
});

type AuthorityCase = {
  name: string;
  trigger: Parameters<typeof createUpdateRun>[0]["trigger"];
  recorded?: UpdateRepairTurnMessage["requester"];
  sent?: UpdateRepairTurnMessage["requester"];
  change?: "origin" | "policy";
  refusal?: string;
};
const revoked = "requester-revoked";
const profile = { ...requester, authorizationSource: "profile:synthetic" };

describe("delegated repair requester binding", () => {
  it.each<AuthorityCase>([
    { name: "omitted chat requester", trigger: "chat", recorded: requester, refusal: revoked },
    {
      name: "substituted chat requester",
      trigger: "chat",
      recorded: requester,
      sent: { ...requester, senderId: "other-owner" },
      refusal: revoked,
    },
    { name: "requester added to CLI", trigger: "cli", sent: requester, refusal: revoked },
    { name: "chat owner", trigger: "chat", recorded: requester, sent: requester },
    { name: "local CLI", trigger: "cli" },
    {
      name: "internal channel",
      trigger: "control-ui",
      recorded: { channel: "webchat" },
      sent: { channel: "webchat" },
    },
    {
      name: "channel-less operator",
      trigger: "api",
      recorded: { senderId: "operator" },
      sent: { senderId: "operator" },
    },
    {
      name: "changed origin",
      trigger: "chat",
      recorded: requester,
      sent: requester,
      change: "origin",
      refusal: revoked,
    },
    {
      name: "changed policy",
      trigger: "chat",
      recorded: requester,
      sent: requester,
      change: "policy",
      refusal: revoked,
    },
    {
      name: "profile without native continuation",
      trigger: "chat",
      recorded: profile,
      sent: profile,
      refusal: "Requester continuation requires its admitted Gateway update owner.",
    },
  ])(
    "checks $name before allowing inference effects",
    async ({ trigger, recorded, sent, change, refusal }) => {
      await withOpenClawTestState({ layout: "home" }, async (state) => {
        await state.writeConfig({ commands: { ownerAllowFrom: ["owner", "other-owner"] } });
        const run = createUpdateRun(
          { trigger, origin: { requester: recorded } },
          { env: state.env },
        );
        recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
        if (change) {
          runtime.prepareUpdateRepairInference.mockImplementationOnce(async () => {
            if (change === "origin") {
              recordUpdateRunPhase(
                run.runId,
                "repairing",
                {
                  origin: { requester: { ...requester, senderId: "other-owner" } },
                },
                { env: state.env },
              );
            } else {
              await state.writeConfig({ commands: { ownerAllowFrom: ["other-owner"] } });
            }
            return selected;
          });
        }
        const onRoute = vi.fn();
        const result = await runDelegatedUpdateRepairTurn(
          message(run.runId, state, sent),
          state.env,
          new AbortController().signal,
          onRoute,
        );
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
    },
  );

  it("keeps in-turn liveness cheap and refuses revoked authority before tool effects", async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      await state.writeConfig({ commands: { ownerAllowFrom: ["owner"] } });
      const run = createUpdateRun({ trigger: "chat", origin: { requester } }, { env: state.env });
      recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
      // Like the delegated worker, read the updater's ledger without holding its writer.
      await closeOpenClawStateDatabaseAsync();
      const snapshots = vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync");
      try {
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
          return {
            toolCalls: 0,
            envelope: { model: "repair", provider: "fixture", final: "No changes", status: "ok" },
          };
        });
        const result = await runDelegatedUpdateRepairTurn(
          message(run.runId, state, requester),
          state.env,
          new AbortController().signal,
          vi.fn(),
        );
        expect(result).toMatchObject({ status: "aborted", reason: revoked });
        expect(snapshots).toHaveBeenCalled();
      } finally {
        snapshots.mockRestore();
      }
    });
  });
});

function message(
  runId: string,
  state: { stateDir: string; configPath: string; workspaceDir: string },
  admitted: UpdateRepairTurnMessage["requester"],
): UpdateRepairTurnMessage {
  return {
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
}
