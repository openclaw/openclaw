import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { registerSupervisedTaskAdmissionOwner } from "./supervised-task.admission-owner.js";
import { maybeAdmitSupervisedRootTask } from "./supervised-task.admission.js";
import { readSupervisedInputReceipt, supervisedInputIdentity } from "./supervised-task.source.js";
import {
  getSupervisedTask,
  heartbeatTaskSupervisor,
  claimSupervisedTask,
  reserveSupervisedDispatch,
  settleSupervisedDecision,
} from "./supervised-task.store.js";
const mocks = vi.hoisted(() => ({ classify: vi.fn(), runtime: vi.fn() }));
vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion: mocks.classify }));
vi.mock("../agents/harness/policy.js", () => ({ resolveAgentHarnessPolicy: mocks.runtime }));
const dirs = createTempDirTracker();
let unregister: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  mocks.classify
    .mockReset()
    .mockResolvedValue({ text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } });
  mocks.runtime.mockReset().mockReturnValue({ runtime: "codex", runtimeSource: "model" });
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
async function fixture() {
  const root = dirs.make("supervised-admission-");
  const workspace = `${root}/work`;
  await fs.mkdir(workspace);
  const policyFile = `${root}/policy.json`;
  await fs.writeFile(
    policyFile,
    JSON.stringify({
      version: 1,
      scope: "Repair fixture source",
      goal: {
        objective: "Repair the fixture",
        success: [{ id: "correct", description: "Reviewed output" }],
        partial: [],
      },
      workflow: {
        version: 1,
        workspace,
        profiles: [],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
      },
      maxAttempts: 4,
      attemptTimeoutMs: 10_000,
      episodeTimeoutMs: 60_000,
    }),
    { mode: 0o600 },
  );
  const options = { path: `${root}/state.sqlite` };
  heartbeatTaskSupervisor("native-owner", 1000, 10_000, options);
  unregister = registerSupervisedTaskAdmissionOwner(async () => "native-owner");
  const config: OpenClawConfig = {
    agents: { entries: { poc: { taskSupervision: { enabled: true, policyFile } } } },
  };
  return {
    config,
    source: {
      agentId: "poc",
      sessionKey: "agent:poc:main",
      sessionId: "session-one",
      namespace: "gateway" as const,
      inputId: "input-one",
      ownerScope: "authorized-session",
    },
    message: "Repair the source",
    model: "openai/fixture",
    ownerAuthorized: true,
    internal: false,
    assertCurrent: () => {},
    options,
  };
}
it("commits one task for concurrent input replay and retains the accepted request", async () => {
  const f = await fixture();
  const results = await Promise.all([
    maybeAdmitSupervisedRootTask(f),
    maybeAdmitSupervisedRootTask(f),
  ]);
  expect(results.every((result) => result.kind === "admitted")).toBe(true);
  const first = results[0]!;
  if (first.kind !== "admitted") {
    throw new Error("Expected custody");
  }
  expect(results[1]).toMatchObject({ flowId: first.flowId, episode: 1 });
  expect(getSupervisedTask(first.flowId, f.options)).toMatchObject({
    prompt: f.message,
    phase: "ready",
    attempts: 0,
  });
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options)
      ?.flow_id,
  ).toBe(first.flowId);
  await expect(
    maybeAdmitSupervisedRootTask({ ...f, message: "Different request" }),
  ).rejects.toThrow(/reused/);
});
it("does not admit internal execution, unauthorized senders, or commands", async () => {
  const f = await fixture();
  for (const params of [
    { ...f, internal: true },
    { ...f, ownerAuthorized: false },
    { ...f, message: "/status" },
  ]) {
    expect(await maybeAdmitSupervisedRootTask(params)).toEqual({ kind: "ordinary" });
  }
  expect(mocks.classify).not.toHaveBeenCalled();
});
it("ordinary conversation retains a replay receipt without creating a task", async () => {
  const f = await fixture();
  mocks.classify.mockResolvedValue({
    text: '{"kind":"ordinary"}',
    owner: { kind: "harness", id: "codex" },
  });
  expect(await maybeAdmitSupervisedRootTask(f)).toEqual({ kind: "ordinary" });
  expect(await maybeAdmitSupervisedRootTask(f)).toEqual({ kind: "ordinary" });
  expect(mocks.classify).toHaveBeenCalledTimes(1);
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options),
  ).toMatchObject({ disposition: "ordinary", flow_id: null });
});
it.each([
  { model: "zai/glm-fixture", runtime: "pi", runtimeSource: "model" },
  { model: "openai/fixture", runtime: "codex", runtimeSource: "implicit" },
  { model: "zai/glm-fixture", runtime: "claude-cli", runtimeSource: "model" },
  { model: "anthropic/fixture", runtime: "codex", runtimeSource: "model" },
  { model: "fixture", runtime: "pi", runtimeSource: "implicit" },
])(
  "bypasses supervision for unsupported selection $model/$runtime/$runtimeSource",
  async (selection) => {
    const f = await fixture();
    mocks.runtime.mockReturnValue(selection);
    await fs.unlink(f.config.agents!.entries!.poc!.taskSupervision!.policyFile);
    for (const namespace of ["gateway", "channel"] as const) {
      const params = { ...f, model: selection.model, source: { ...f.source, namespace } };
      expect(await maybeAdmitSupervisedRootTask(params)).toEqual({ kind: "ordinary" });
      expect(await maybeAdmitSupervisedRootTask({ ...params, message: "x".repeat(4097) })).toEqual({
        kind: "ordinary",
      });
      expect(
        readSupervisedInputReceipt(
          supervisedInputIdentity(params.source, params.message).sourceKey,
          f.options,
        ),
      ).toBeUndefined();
    }
    expect(mocks.classify).not.toHaveBeenCalled();
  },
);
it("replays committed task custody after switching to an unsupported runtime", async () => {
  const f = await fixture();
  const admitted = await maybeAdmitSupervisedRootTask(f);
  expect(admitted.kind).toBe("admitted");
  mocks.runtime.mockReturnValue({ runtime: "pi", runtimeSource: "model" });
  mocks.classify.mockClear();
  await fs.unlink(f.config.agents!.entries!.poc!.taskSupervision!.policyFile);
  expect(await maybeAdmitSupervisedRootTask({ ...f, model: "zai/glm-fixture" })).toEqual({
    ...admitted,
    replay: true,
  });
  expect(mocks.classify).not.toHaveBeenCalled();
});
it("refuses a classifier result after source authority is revoked", async () => {
  const f = await fixture();
  let current = true;
  mocks.classify.mockImplementation(async () => {
    current = false;
    return { text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } };
  });
  await expect(
    maybeAdmitSupervisedRootTask({
      ...f,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Source revoked");
        }
      },
    }),
  ).rejects.toThrow("Source revoked");
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options),
  ).toBeUndefined();
});
it("cannot replace an unavailable supervisor with a synthetic admission heartbeat", async () => {
  const f = await fixture();
  unregister?.();
  await expect(maybeAdmitSupervisedRootTask(f)).rejects.toThrow(/No native supervision/);
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options),
  ).toBeUndefined();
});
it("rejects runtime fallback and malformed classification without ordinary execution", async () => {
  const f = await fixture();
  mocks.classify.mockResolvedValue({
    text: '{"kind":"task"}',
    owner: { kind: "cli", id: "other" },
  });
  await expect(maybeAdmitSupervisedRootTask(f)).rejects.toThrow(/runtime owner/);
  mocks.classify.mockResolvedValue({
    text: "I will do it",
    owner: { kind: "harness", id: "codex" },
  });
  await expect(maybeAdmitSupervisedRootTask(f)).rejects.toThrow();
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options),
  ).toBeUndefined();
});

it.each(["codex", "claude-cli"] as const)(
  "%s task status uses a read-only projection and a durable replay reply",
  async (runtime) => {
    const f = await fixture();
    mocks.runtime.mockReturnValue({ runtime, runtimeSource: "model" });
    const owner =
      runtime === "codex" ? { kind: "harness", id: "codex" } : { kind: "cli", id: "claude-cli" };
    const params = { ...f, model: runtime === "codex" ? "openai/fixture" : "anthropic/fixture" };
    mocks.classify.mockResolvedValue({ text: '{"kind":"task"}', owner });
    const admitted = await maybeAdmitSupervisedRootTask(params);
    if (admitted.kind !== "admitted") {
      throw new Error("Expected task");
    }
    const before = getSupervisedTask(admitted.flowId, f.options);
    unregister?.();
    unregister = undefined;
    mocks.classify.mockResolvedValue({ text: '{"kind":"status"}', owner });
    const status = {
      ...params,
      source: { ...f.source, inputId: "status-one" },
      message: "How is that task doing?",
    };
    const first = await maybeAdmitSupervisedRootTask(status);
    expect(first).toMatchObject({
      kind: "handled",
      flowId: admitted.flowId,
      message: expect.stringContaining("Continuation: armed"),
    });
    expect(getSupervisedTask(admitted.flowId, f.options)).toEqual(before);
    expect(await maybeAdmitSupervisedRootTask(status)).toEqual({ ...first, replay: true });
    expect(mocks.classify).toHaveBeenCalledTimes(2);
  },
);
it("natural steering and cancellation commit once without changing accepted criteria", async () => {
  const f = await fixture();
  const admitted = await maybeAdmitSupervisedRootTask(f);
  if (admitted.kind !== "admitted") {
    throw new Error("Expected task");
  }
  const before = getSupervisedTask(admitted.flowId, f.options)!;
  mocks.classify.mockResolvedValue({
    text: '{"kind":"steer"}',
    owner: { kind: "harness", id: "codex" },
  });
  const correction = {
    ...f,
    source: { ...f.source, inputId: "correction" },
    message: "Include the empty case",
  };
  expect(await maybeAdmitSupervisedRootTask(correction)).toMatchObject({
    kind: "handled",
    flowId: admitted.flowId,
  });
  const changed = getSupervisedTask(admitted.flowId, f.options)!;
  expect(changed).toMatchObject({
    next: correction.message,
    goal: before.goal,
    policy: before.policy,
  });
  await maybeAdmitSupervisedRootTask(correction);
  expect(getSupervisedTask(admitted.flowId, f.options)).toEqual(changed);
  mocks.classify.mockResolvedValue({
    text: '{"kind":"cancel"}',
    owner: { kind: "harness", id: "codex" },
  });
  expect(
    await maybeAdmitSupervisedRootTask({
      ...f,
      source: { ...f.source, inputId: "cancel" },
      message: "Stop this task",
    }),
  ).toMatchObject({ kind: "handled" });
  expect(getSupervisedTask(admitted.flowId, f.options)?.phase).toBe("cancelled");
});
it("resumes the exact input endpoint with host-supplied limits and preserves the old episode", async () => {
  const f = await fixture();
  const admitted = await maybeAdmitSupervisedRootTask(f);
  if (admitted.kind !== "admitted") {
    throw new Error("Expected task");
  }
  const attempt = reserveSupervisedDispatch(
    claimSupervisedTask(admitted.flowId, "native-owner", 1000, f.options)!,
    1000,
    f.options,
  );
  const endpoint = settleSupervisedDecision(
    attempt,
    { kind: "input_required", reason: "Need target", question: "Which fixture?" },
    1000,
    f.options,
  );
  mocks.classify.mockResolvedValue({
    text: '{"kind":"resume"}',
    owner: { kind: "harness", id: "codex" },
  });
  const resume = {
    ...f,
    source: { ...f.source, inputId: "resume" },
    message: "Use the small fixture and continue",
  };
  expect(await maybeAdmitSupervisedRootTask(resume)).toMatchObject({ kind: "handled", episode: 2 });
  expect(getSupervisedTask(admitted.flowId, f.options)?.policy).toEqual(endpoint.policy);
  expect(getSupervisedTask(admitted.flowId, f.options, 1)).toEqual(endpoint);
  await maybeAdmitSupervisedRootTask(resume);
  expect(getSupervisedTask(admitted.flowId, f.options)?.episode).toBe(2);
});
it("asks for selection when two active tasks match and rejects invented cross-source targets", async () => {
  const f = await fixture();
  const first = await maybeAdmitSupervisedRootTask(f);
  if (first.kind !== "admitted") {
    throw new Error("Expected task");
  }
  const policyFile = f.config.agents!.entries!.poc!.taskSupervision!.policyFile;
  const policy = JSON.parse(await fs.readFile(policyFile, "utf8"));
  policy.workflow.workspace += "-second";
  await fs.mkdir(policy.workflow.workspace);
  await fs.writeFile(policyFile, JSON.stringify(policy));
  const second = await maybeAdmitSupervisedRootTask({
    ...f,
    source: { ...f.source, inputId: "second" },
  });
  if (second.kind !== "admitted") {
    throw new Error("Expected second task");
  }
  const before = [
    getSupervisedTask(first.flowId, f.options),
    getSupervisedTask(second.flowId, f.options),
  ];
  mocks.classify.mockResolvedValue({
    text: '{"kind":"cancel"}',
    owner: { kind: "harness", id: "codex" },
  });
  const cancel = { ...f, source: { ...f.source, inputId: "ambiguous" }, message: "Stop the task" };
  expect(await maybeAdmitSupervisedRootTask(cancel)).toMatchObject({
    kind: "handled",
    message: expect.stringContaining("Select the task"),
  });
  expect([
    getSupervisedTask(first.flowId, f.options),
    getSupervisedTask(second.flowId, f.options),
  ]).toEqual(before);
  mocks.classify.mockResolvedValue({
    text: '{"kind":"cancel","target":"other-session-task"}',
    owner: { kind: "harness", id: "codex" },
  });
  await expect(
    maybeAdmitSupervisedRootTask({ ...cancel, source: { ...f.source, inputId: "forged" } }),
  ).rejects.toThrow(/outside/);
});

it.each(
  ["stop", "/stop", "please stop!"].flatMap((message) =>
    [true, false, undefined].map((enabled) => ({ message, enabled })),
  ),
)(
  "honors $message with admission $enabled without model availability or rereading policy",
  async ({ message, enabled }) => {
    const f = await fixture();
    const admitted = await maybeAdmitSupervisedRootTask(f);
    if (admitted.kind !== "admitted") {
      throw new Error("Expected task");
    }
    mocks.classify.mockReset().mockRejectedValue(new Error("Model offline"));
    await fs.unlink(f.config.agents!.entries!.poc!.taskSupervision!.policyFile);
    const agent = f.config.agents!.entries!.poc!;
    if (enabled === undefined) {
      delete agent.taskSupervision;
    } else {
      agent.taskSupervision!.enabled = enabled;
    }
    if (!enabled) {
      expect(
        await maybeAdmitSupervisedRootTask({
          ...f,
          source: { ...f.source, inputId: "disabled-new-input" },
          message: "Repair another source",
        }),
      ).toEqual({ kind: "ordinary" });
    }
    mocks.runtime.mockReturnValue({ runtime: "pi", runtimeSource: "model" });
    const stop = {
      ...f,
      model: "zai/glm-fixture",
      source: { ...f.source, inputId: "stop-input" },
      message,
    };
    expect(await maybeAdmitSupervisedRootTask(stop)).toMatchObject({
      kind: "handled",
      control: "cancel",
      flowId: admitted.flowId,
    });
    const endpoint = getSupervisedTask(admitted.flowId, f.options);
    expect(endpoint?.phase).toBe("cancelled");
    expect(await maybeAdmitSupervisedRootTask(stop)).toMatchObject({
      kind: "handled",
      replay: true,
    });
    expect(getSupervisedTask(admitted.flowId, f.options)).toEqual(endpoint);
    expect(mocks.classify).not.toHaveBeenCalled();
  },
);

it("rejects an oversized eligible request instead of silently sending it to unsupervised execution", async () => {
  const f = await fixture();
  await expect(maybeAdmitSupervisedRootTask({ ...f, message: "x".repeat(4097) })).rejects.toThrow(
    /supervised.*budget/i,
  );
  expect(mocks.classify).not.toHaveBeenCalled();
});

it("rejects policy replacement while the classifier is awaiting without accepting stale authority", async () => {
  const f = await fixture();
  mocks.classify.mockImplementation(async () => {
    const file = f.config.agents!.entries!.poc!.taskSupervision!.policyFile;
    const policy = JSON.parse(await fs.readFile(file, "utf8"));
    policy.scope = "Changed by operator during classification";
    await fs.writeFile(file, JSON.stringify(policy));
    return { text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } };
  });
  await expect(maybeAdmitSupervisedRootTask(f)).rejects.toThrow(/policy changed/i);
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options),
  ).toBeUndefined();
});

it.each(["symlink", "hardlink", "writable"])(
  "rejects %s policy files before model classification",
  async (kind) => {
    const f = await fixture();
    const file = f.config.agents!.entries!.poc!.taskSupervision!.policyFile;
    if (kind === "symlink") {
      await fs.rename(file, `${file}.original`);
      await fs.symlink(`${file}.original`, file);
    } else if (kind === "hardlink") {
      await fs.link(file, `${file}.alias`);
    } else {
      await fs.chmod(file, 0o666);
    }
    await expect(maybeAdmitSupervisedRootTask(f)).rejects.toThrow();
    expect(mocks.classify).not.toHaveBeenCalled();
  },
);

it("rejects a policy changed during supervisor preparation before creating the episode", async () => {
  const f = await fixture();
  const ensureOwner = async () => {
    const file = f.config.agents!.entries!.poc!.taskSupervision!.policyFile;
    const policy = JSON.parse(await fs.readFile(file, "utf8"));
    policy.maxAttempts = 1;
    await fs.writeFile(file, JSON.stringify(policy));
    return "native-owner";
  };
  await expect(maybeAdmitSupervisedRootTask({ ...f, ensureOwner })).rejects.toThrow(
    /policy changed/i,
  );
  expect(
    readSupervisedInputReceipt(supervisedInputIdentity(f.source, f.message).sourceKey, f.options),
  ).toBeUndefined();
});

it("binds the operator credential profile to classification and the durable task", async () => {
  const f = await fixture();
  const file = f.config.agents!.entries!.poc!.taskSupervision!.policyFile!;
  const policy = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...policy, authProfiles: { openai: "openai:work" } }));
  const result = await maybeAdmitSupervisedRootTask(f);
  expect(mocks.classify).toHaveBeenCalledWith(
    expect.objectContaining({ authProfileId: "openai:work" }),
  );
  if (result.kind !== "admitted") {
    throw new Error("Expected admission");
  }
  expect(getSupervisedTask(result.flowId, f.options)?.authProfileId).toBe("openai:work");
  const claimed = claimSupervisedTask(result.flowId, "native-owner", 1001, f.options);
  expect(claimed?.authProfileId).toBe("openai:work");
});
