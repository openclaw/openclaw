import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const selected = {
  ok: true,
  route: { model: "repair", provider: "fixture" },
  modelFallbacks: [],
};
const completed = {
  toolCalls: 0,
  envelope: { model: "repair", provider: "fixture", final: "No changes", status: "ok" },
};
const connected = Object.getOwnPropertyDescriptor(process, "connected");
beforeEach(() => {
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  vi.clearAllMocks();
  runtime.prepareUpdateRepairInference.mockResolvedValue(selected);
  runtime.runUpdateRepairTurn.mockImplementation(async ({ isCurrent }) => {
    isCurrent();
    return completed;
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
const chat = (name: string, overrides: Partial<AuthorityCase> = {}): AuthorityCase => ({
  name,
  trigger: "chat",
  recorded: requester,
  sent: requester,
  ...overrides,
});

function withRun(
  operation: (state: OpenClawTestState, runId: string) => Promise<void>,
  input = chat(""),
) {
  return withOpenClawTestState({ layout: "home" }, async (state) => {
    await state.writeConfig({ commands: { ownerAllowFrom: ["owner", "other-owner"] } });
    const run = createUpdateRun(
      { trigger: input.trigger, origin: { requester: input.recorded } },
      { env: state.env },
    );
    recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
    await operation(state, run.runId);
  });
}

describe("delegated repair requester binding", () => {
  it.each<AuthorityCase>([
    chat("omitted chat requester", { sent: undefined, refusal: revoked }),
    chat("substituted chat requester", {
      sent: { ...requester, senderId: "other-owner" },
      refusal: revoked,
    }),
    { name: "requester added to CLI", trigger: "cli", sent: requester, refusal: revoked },
    chat("chat owner"),
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
    chat("changed origin", { change: "origin", refusal: revoked }),
    chat("changed policy", { change: "policy", refusal: revoked }),
    chat("profile without native continuation", {
      recorded: profile,
      sent: profile,
      refusal: "Requester continuation requires its admitted Gateway update owner.",
    }),
  ])("checks $name before allowing inference effects", async (input) => {
    const { sent, change, refusal } = input;
    await withRun(async (state, runId) => {
      if (change) {
        runtime.prepareUpdateRepairInference.mockImplementationOnce(async () => {
          if (change === "origin") {
            recordUpdateRunPhase(
              runId,
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
    }, input);
  });

  it("keeps in-turn liveness cheap and refuses revoked authority before tool effects", async () => {
    await withRun(async (state, runId) => {
      await state.writeConfig({ commands: { ownerAllowFrom: ["owner"] } });
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
          return completed;
        });
        const result = await runTurn(runId, state, requester);
        expect(result).toMatchObject({ status: "aborted", reason: revoked });
        expect(snapshots).toHaveBeenCalled();
      } finally {
        snapshots.mockRestore();
      }
    });
  });
});

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
