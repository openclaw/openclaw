import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

describe("delegated repair requester binding", () => {
  it.each([
    { name: "omitted chat requester", trigger: "chat", recorded: requester, sent: undefined },
    {
      name: "substituted chat requester",
      trigger: "chat",
      recorded: requester,
      sent: { ...requester, senderId: "other-owner" },
    },
    { name: "requester added to a CLI run", trigger: "cli", recorded: undefined, sent: requester },
  ] as const)("refuses $name before selecting inference", async ({ trigger, recorded, sent }) => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      await state.writeConfig({ commands: { ownerAllowFrom: ["owner", "other-owner"] } });
      const run = createUpdateRun({ trigger, origin: { requester: recorded } }, { env: state.env });
      recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
      const result = await runDelegatedUpdateRepairTurn(
        message(run.runId, state, sent),
        state.env,
        new AbortController().signal,
        vi.fn(),
      );
      expect(result).toMatchObject({ status: "aborted", reason: "requester-revoked" });
      expect(runtime.prepareUpdateRepairInference).not.toHaveBeenCalled();
      expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "chat owner", trigger: "chat", recorded: requester },
    { name: "local CLI", trigger: "cli", recorded: undefined },
    { name: "Control UI", trigger: "control-ui", recorded: undefined },
    { name: "API", trigger: "api", recorded: undefined },
    { name: "campaign", trigger: "campaign", recorded: undefined },
    { name: "Mac app", trigger: "mac-app", recorded: undefined },
    { name: "internal channel", trigger: "control-ui", recorded: { channel: "webchat" } },
    { name: "channel-less operator", trigger: "api", recorded: { senderId: "operator" } },
  ] as const)("accepts the recorded $name authority", async ({ trigger, recorded }) => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      await state.writeConfig({ commands: { ownerAllowFrom: ["owner"] } });
      const run = createUpdateRun({ trigger, origin: { requester: recorded } }, { env: state.env });
      recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
      expect(
        await runDelegatedUpdateRepairTurn(
          message(run.runId, state, recorded),
          state.env,
          new AbortController().signal,
          vi.fn(),
        ),
      ).toMatchObject({ status: "completed", toolCalls: 0 });
    });
  });

  it.each(["origin", "policy"] as const)(
    "refuses a changed %s after awaited route preparation",
    async (change) => {
      await withOpenClawTestState({ layout: "home" }, async (state) => {
        await state.writeConfig({ commands: { ownerAllowFrom: ["owner", "other-owner"] } });
        const run = createUpdateRun({ trigger: "chat", origin: { requester } }, { env: state.env });
        recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
        runtime.prepareUpdateRepairInference.mockImplementationOnce(async () => {
          if (change === "origin") {
            recordUpdateRunPhase(
              run.runId,
              "repairing",
              { origin: { requester: { ...requester, senderId: "other-owner" } } },
              { env: state.env },
            );
          } else {
            await state.writeConfig({ commands: { ownerAllowFrom: ["other-owner"] } });
          }
          return selected;
        });
        const onRoute = vi.fn();
        expect(
          await runDelegatedUpdateRepairTurn(
            message(run.runId, state, requester),
            state.env,
            new AbortController().signal,
            onRoute,
          ),
        ).toMatchObject({ status: "aborted", reason: "requester-revoked" });
        expect(onRoute).not.toHaveBeenCalled();
        expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
      });
    },
  );

  it("retains the native continuation requirement for a recorded profile", async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      const recorded = { ...requester, authorizationSource: "profile:synthetic" };
      const run = createUpdateRun(
        { trigger: "chat", origin: { requester: recorded } },
        { env: state.env },
      );
      recordUpdateRunPhase(run.runId, "repairing", undefined, { env: state.env });
      expect(
        await runDelegatedUpdateRepairTurn(
          message(run.runId, state, recorded),
          state.env,
          new AbortController().signal,
          vi.fn(),
        ),
      ).toMatchObject({
        status: "aborted",
        reason: "Requester continuation requires its admitted Gateway update owner.",
      });
      expect(runtime.prepareUpdateRepairInference).not.toHaveBeenCalled();
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
