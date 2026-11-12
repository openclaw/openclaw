import { expect, it, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import { deleteAfterLifecycleRace } from "./sqlite-flip-proof-races.js";

const key = "agent:main:dashboard:synthetic-delete";
function conflict(options: { code?: string; reason?: string; correlated?: boolean } = {}) {
  const error = new GatewayProtocolRequestError({
    code: options.code ?? "INVALID_REQUEST",
    message: `Session ${key} changed before deletion. Retry.`,
    details: { reason: options.reason ?? "session-changed" },
  });
  if (options.correlated !== false) {
    retainGatewayResponsePayload(error, undefined);
  }
  return error;
}
it("settles before one retry of an authoritative lifecycle conflict", async () => {
  const calls: string[] = [];
  const remove = vi
    .fn<() => Promise<{ ok: boolean; deleted: boolean }>>()
    .mockImplementationOnce(async () => {
      calls.push("first");
      throw conflict();
    })
    .mockImplementationOnce(async () => {
      calls.push("retry");
      return { ok: true, deleted: true };
    });
  await deleteAfterLifecycleRace({
    key,
    remove,
    settle: async () => {
      calls.push("settle");
    },
  });
  expect(calls).toEqual(["first", "settle", "retry"]);
});
it.each([{ code: "FORBIDDEN" }, { reason: "other-denial" }, { correlated: false }])(
  "does not retry other or uncorrelated failures: %j",
  async (options) => {
    const error = conflict(options);
    const remove = vi
      .fn<() => Promise<{ ok: boolean; deleted: boolean }>>()
      .mockRejectedValue(error);
    const settle = vi.fn<() => Promise<void>>();
    await expect(deleteAfterLifecycleRace({ key, remove, settle })).rejects.toBe(error);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  },
);
it("does not retry a second conflict", async () => {
  const error = conflict();
  const remove = vi.fn<() => Promise<{ ok: boolean; deleted: boolean }>>().mockRejectedValue(error);
  const settle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  await expect(deleteAfterLifecycleRace({ key, remove, settle })).rejects.toBe(error);
  expect(remove).toHaveBeenCalledTimes(2);
  expect(settle).toHaveBeenCalledTimes(1);
});
it("does not retry if the owned run fails to settle", async () => {
  const remove = vi
    .fn<() => Promise<{ ok: boolean; deleted: boolean }>>()
    .mockRejectedValue(conflict());
  const failure = new Error("run still active");
  await expect(
    deleteAfterLifecycleRace({
      key,
      remove,
      settle: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(remove).toHaveBeenCalledTimes(1);
});
