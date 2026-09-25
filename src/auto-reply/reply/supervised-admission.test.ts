import { beforeEach, expect, it, vi } from "vitest";
import type { maybeAdmitSupervisedRootTask } from "../../tasks/supervised-task.admission.js";
import type { RuntimeMsgContext } from "../templating.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";
import { maybeAdmitSupervisedChannelTask } from "./supervised-admission.js";
const mocks = vi.hoisted(() => ({
  admit: vi.fn<typeof maybeAdmitSupervisedRootTask>(),
  session: vi.fn(),
}));
vi.mock("../../tasks/supervised-task.admission.js", () => ({
  maybeAdmitSupervisedRootTask: mocks.admit,
}));
vi.mock("../../tasks/supervised-task.root-source.js", () => ({
  bindSupervisedRootSource: (params: object) => params,
}));
vi.mock("../../gateway/session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.session,
}));
beforeEach(() => {
  mocks.session.mockReset().mockReturnValue({ entry: { sessionId: "session-one" } });
  mocks.admit.mockReset().mockImplementation(async (params) => {
    params.assertCurrent();
    return { kind: "admitted", flowId: "task-one", episode: 1, replay: false };
  });
});
function fixture() {
  const ctx: RuntimeMsgContext = {
    agentText: "Repair fixture",
    commandText: "Repair fixture",
    rawText: "Repair fixture",
  };
  setChannelSourceTurnId(ctx, "host-input-one");
  const state: ReplyOperationRunState = {};
  const adopted = vi.fn();
  const abandoned = vi.fn();
  const settled = vi.fn();
  return {
    config: {},
    agentId: "poc",
    sessionKey: "agent:poc:main",
    sessionId: "session-one",
    ctx,
    message: "Repair fixture",
    model: "openai/fixture",
    senderIsOwner: true,
    options: {
      [REPLY_OPERATION_RUN_STATE]: state,
      turnAdoptionLifecycle: { onAdopted: adopted, onAbandoned: abandoned, onSettled: settled },
    },
    state,
    adopted,
    abandoned,
    settled,
  };
}
it("hands off ingress only after durable admission and never calls it a backend injection", async () => {
  const f = fixture();
  mocks.admit.mockImplementation(async (params) => {
    params.assertCurrent();
    expect(f.adopted).not.toHaveBeenCalled();
    expect(f.state.admission).toBeUndefined();
    return { kind: "admitted", flowId: "task-one", episode: 1, replay: false };
  });
  expect(await maybeAdmitSupervisedChannelTask(f)).toBe(true);
  expect(f.state.admission).toEqual({ status: "accepted", mode: "supervised" });
  expect(f.adopted).toHaveBeenCalledTimes(1);
  expect(f.settled).toHaveBeenCalledTimes(1);
  expect(f.abandoned).not.toHaveBeenCalled();
});
it("leaves ordinary replies to their original owner", async () => {
  const f = fixture();
  mocks.admit.mockResolvedValue({ kind: "ordinary" });
  expect(await maybeAdmitSupervisedChannelTask(f)).toBe(false);
  expect(f.state.admission).toBeUndefined();
  expect(f.adopted).not.toHaveBeenCalled();
  expect(f.settled).not.toHaveBeenCalled();
});
it("does not create identity from body text or adopt an internal/unauthorized input", async () => {
  const f = fixture();
  setChannelSourceTurnId(f.ctx, undefined);
  expect(await maybeAdmitSupervisedChannelTask(f)).toBe(false);
  setChannelSourceTurnId(f.ctx, "host-input-one");
  expect(await maybeAdmitSupervisedChannelTask({ ...f, senderIsOwner: false })).toBe(false);
  expect(
    await maybeAdmitSupervisedChannelTask({
      ...f,
      ctx: { ...f.ctx, InputProvenance: { kind: "internal_system" } },
    }),
  ).toBe(false);
  expect(mocks.admit).not.toHaveBeenCalled();
});
it("rechecks exact source incarnation before transferring custody", async () => {
  const f = fixture();
  mocks.session.mockReturnValue({ entry: { sessionId: "new-session" } });
  await expect(maybeAdmitSupervisedChannelTask(f)).rejects.toThrow(/source changed/);
  expect(f.adopted).not.toHaveBeenCalled();
  expect(f.state.admission).toBeUndefined();
});
it("retains the durable receipt if ingress adoption itself loses its response", async () => {
  const f = fixture();
  f.adopted.mockImplementation(() => {
    throw new Error("Lost adoption response");
  });
  await expect(maybeAdmitSupervisedChannelTask(f)).rejects.toThrow("Lost adoption response");
  expect(f.state.admission).toEqual({ status: "accepted", mode: "supervised" });
  expect(f.abandoned).not.toHaveBeenCalled();
});
it("returns a host-owned task-control reply without invoking a backend", async () => {
  const f = fixture();
  mocks.admit.mockResolvedValue({
    kind: "handled",
    replay: false,
    message: "Task cancelled. Earlier effects may remain.",
  });
  expect(await maybeAdmitSupervisedChannelTask(f)).toBe(
    "Task cancelled. Earlier effects may remain.",
  );
  expect(f.adopted).toHaveBeenCalledTimes(1);
  expect(f.settled).toHaveBeenCalledTimes(1);
});
