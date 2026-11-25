import { expectTypeOf, it } from "vitest";
import type { enqueueCommandInLane } from "./command-queue.js";
import type { CommandQueueEnqueueFn, CommandQueueEnqueueOptions } from "./command-queue.types.js";

it("keeps execution timeout options on callbacks and out of direct queue admission", () => {
  type AdmissionOptions = NonNullable<Parameters<typeof enqueueCommandInLane>[2]>;
  type TimeoutKey =
    | "taskTimeoutMs"
    | "taskTimeoutProgressAtMs"
    | "taskTimeoutSubscribe"
    | "taskTimeoutAbortSignal"
    | "taskTimeoutAbortGraceMs"
    | "taskTimeoutReleaseSignal";
  expectTypeOf<Extract<keyof AdmissionOptions, TimeoutKey>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof CommandQueueEnqueueOptions, TimeoutKey>>().toEqualTypeOf<TimeoutKey>();
  expectTypeOf<
    NonNullable<Parameters<CommandQueueEnqueueFn>[1]>
  >().toEqualTypeOf<CommandQueueEnqueueOptions>();
});
