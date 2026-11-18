import "./chat-engine.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import {
  createChatEngine,
  expectDefined,
  hashSystemAgentOperation,
  mocks,
  operationMocks,
  RuntimeSystemAgentChatEngine,
  useTempStateDir,
} from "./chat-engine.test-support.js";
import * as inferenceGuard from "./inference-guard.js";
import * as operations from "./operations.js";

it("stages and applies an exact config command without preparing helper inference", async () => {
  useTempStateDir();
  const prepareInference = vi.fn(async () => {
    throw new Error("helper inference is unavailable");
  });
  const engine = new RuntimeSystemAgentChatEngine({
    prepareInference,
    operatorApprovalOnly: true,
  });
  const guard = vi.fn();
  await engine.handle("config set tools.openclaw.autoApproveChanges true");
  const proposal = expectDefined(engine.getPendingOperatorProposal(), "exact config proposal");
  expect(proposal.operation).toEqual({
    kind: "config-set",
    path: "tools.openclaw.autoApproveChanges",
    value: "true",
  });
  expect(operationMocks.runConfigSet).not.toHaveBeenCalled();
  expect(await engine.resolveOperatorApproval("allow-once", proposal.hash, guard)).toMatchObject({
    applied: true,
  });
  expect(guard).toHaveBeenCalled();
  expect(operationMocks.runConfigSet).toHaveBeenCalledOnce();
  expect(await engine.resolveOperatorApproval("allow-once", proposal.hash, guard)).toBeNull();
  expect(prepareInference).not.toHaveBeenCalled();
  await expect(engine.handle("Help me configure the next thing.")).rejects.toThrow(
    "helper inference is unavailable",
  );
  expect(prepareInference).toHaveBeenCalledOnce();
  await engine.dispose();
});

it("keeps a delegated exact proposal pending until an exact host decision", async () => {
  const prepareInference = vi.fn(async () => {
    throw new Error("helper inference is unavailable");
  });
  const engine = new RuntimeSystemAgentChatEngine({ prepareInference, operatorApprovalOnly: true });
  await engine.handle("config set tools.openclaw.autoApproveChanges true");
  const proposal = expectDefined(engine.getPendingOperatorProposal(), "pending policy proposal");
  expect((await engine.handle("yes")).text).toContain("Approval pending");
  await engine.handle("config unset tools.openclaw.autoApproveChanges");
  expect(engine.getPendingOperatorProposal()).toEqual(proposal);
  expect(await engine.resolveOperatorApproval("deny", proposal.hash)).toMatchObject({
    applied: false,
  });
  expect(engine.getPendingOperatorProposal()).toBeNull();
  expect(operationMocks.runConfigSet).not.toHaveBeenCalled();
  expect(operationMocks.runConfigUnset).not.toHaveBeenCalled();
  expect(prepareInference).not.toHaveBeenCalled();
  await engine.dispose();
});

it.each(["yes", "no"])(
  "handles direct exact-command confirmation %s without inference",
  async (decision) => {
    useTempStateDir();
    const prepareInference = vi.fn(async () => {
      throw new Error("helper inference is unavailable");
    });
    const engine = new RuntimeSystemAgentChatEngine({ prepareInference });
    await engine.handle("config set gateway.port 19001");
    const reply = await engine.handle(decision);
    if (decision === "yes") {
      expect(reply.applied).toBe(true);
      expect(operationMocks.runConfigSet).toHaveBeenCalledOnce();
    } else {
      expect(reply.text).toContain("Skipped");
      expect(operationMocks.runConfigSet).not.toHaveBeenCalled();
    }
    expect(engine.getPendingOperatorProposal()).toBeNull();
    expect(prepareInference).not.toHaveBeenCalled();
    await engine.dispose();
  },
);

it("does not transfer exact-command provenance to a replacement model proposal", async () => {
  const operation = { kind: "config-set" as const, path: "gateway.port", value: "19002" };
  const engine = createChatEngine(
    {
      classifyApproval: async () => "other",
      runAgentTurn: async ({ session }) => {
        session.proposalRef.operation = operation;
        session.proposalRef.current = hashSystemAgentOperation(operation);
        return { text: "Proposed the revised change." };
      },
    },
    true,
  );
  await engine.handle("config set gateway.port 19001");
  await engine.handle("Please revise the proposed port.");
  const proposal = expectDefined(engine.getPendingOperatorProposal(), "model config proposal");
  expect(proposal.operation).toEqual(operation);
  const requireApply = vi
    .spyOn(inferenceGuard, "requireSystemAgentPersistentApplyInference")
    .mockRejectedValue(new Error("fixture model authority is unavailable"));
  const result = await engine.resolveOperatorApproval("allow-once", proposal.hash);
  expect(requireApply).toHaveBeenCalledOnce();
  expect(result?.applied).toBe(false);
  expect(operationMocks.runConfigSet).not.toHaveBeenCalled();
});

it("does not re-probe a prepared runtime or invoke correction inference for exact commands", async () => {
  useTempStateDir();
  const requireRoute = vi.spyOn(inferenceGuard, "requireSystemAgentInferenceRoute");
  const requireApply = vi.spyOn(inferenceGuard, "requireSystemAgentPersistentApplyInference");
  const runAgentTurn = vi.fn(async () => ({ text: "must not run" }));
  const engine = createChatEngine({ yes: true, runAgentTurn }, true);
  operationMocks.runConfigSet.mockRejectedValue(new Error("fixture invalid config"));
  const reply = await engine.handle("config set gateway.port banana");
  expect(reply.applied).toBe(false);
  expect(reply.text).toContain("fixture invalid config");
  expect(requireRoute).not.toHaveBeenCalled();
  expect(requireApply).not.toHaveBeenCalled();
  expect(runAgentTurn).not.toHaveBeenCalled();
  expect(engine.getPendingOperatorProposal()).toBeNull();
});

it("prepares real inference once for conversational work after an exact read", async () => {
  const prepareInference = vi.fn(async () => mocks.sharedVerifiedInference!);
  const runAgentTurn = vi.fn(async () => ({ text: "Ready for setup." }));
  const engine = new RuntimeSystemAgentChatEngine({ prepareInference, runAgentTurn });
  expect((await engine.handle("config validate")).text).toContain("valid");
  expect(prepareInference).not.toHaveBeenCalled();
  expect((await engine.handle("Help with setup.")).text).toBe("Ready for setup.");
  await engine.handle("What next?");
  expect(prepareInference).toHaveBeenCalledOnce();
  expect(runAgentTurn).toHaveBeenCalledTimes(2);
  await engine.dispose();
});

it.each([
  ["config set gateway.port 19001", "config-set"],
  ["config unset tools.openclaw.autoApproveChanges", "config-unset"],
  ["config set-ref channels.discord.token env DISCORD_BOT_TOKEN", "config-set-ref"],
  ["config get gateway.port", "config-get"],
  ["config schema .", "config-schema"],
  ["config validate", "config-validate"],
  ["config get bad[", "none"],
] as const)("recognizes only the existing exact config grammar: %s", (text, kind) => {
  expect(operations.parseSystemAgentConfigCommand(text)?.kind).toBe(kind);
});

it.each(["help", "please change gateway.port", "gateway restart", "plugins install fixture"])(
  "does not classify unrelated input as a deterministic config command: %s",
  (text) => expect(operations.parseSystemAgentConfigCommand(text)).toBeNull(),
);
