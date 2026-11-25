import { expect, it, vi } from "vitest";
import { resolveReplyBackendMessageInjectionRejection } from "./session-controller.message-injection-backend.js";

it.each([
  { probe: "isStopped", throws: false, runtimeReason: "turn_not_steerable" },
  { probe: "isStopped", throws: true, runtimeReason: "availability_check_failed" },
  { probe: "isCompacting", throws: false, runtimeReason: "compaction_in_progress" },
  { probe: "isCompacting", throws: true, runtimeReason: "compaction_state_unavailable" },
])("reports $runtimeReason before enqueue", ({ probe, throws, runtimeReason }) => {
  const queueMessage = vi.fn(async () => {});
  expect(
    resolveReplyBackendMessageInjectionRejection({
      sessionId: "synthetic-unavailable",
      canInject: () => true,
      backend: {
        kind: "embedded",
        cancel() {},
        queueMessage,
        [probe]: () => {
          if (throws) {
            throw new Error("state unavailable");
          }
          return true;
        },
      },
    }),
  ).toMatchObject({ reason: "injection_unavailable", runtimeReason });
  expect(queueMessage).not.toHaveBeenCalled();
});

it("reports a missing runtime injection capability", () => {
  expect(
    resolveReplyBackendMessageInjectionRejection({
      sessionId: "synthetic-unsupported",
      backend: { kind: "embedded", cancel() {} },
      canInject: () => true,
    }),
  ).toEqual({ reason: "injection_unavailable", runtimeReason: "injection_unsupported" });
});
