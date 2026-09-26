import { describe, expectTypeOf, it } from "vitest";
import type {
  RegisteredWorkerProvider,
  WorkerProviderV1,
} from "../plugins/capability-provider.types.js";
import type { OpenClawPluginApi, WorkerProvider } from "./plugin-entry.js";

// Compile-only calls protect the shipped two-argument legacy shape and the V1 boundary.
function checkProvisionCalls(legacy: WorkerProvider, modern: WorkerProvider<1>) {
  void legacy.provision({}, "legacy");
  void legacy.provision({}, "legacy-options", {});
  // @ts-expect-error V1 requires host-owned invocation options.
  void modern.provision({}, "missing-options");
  // @ts-expect-error V1 cannot provision without a live invocation guard.
  void modern.provision({}, "missing-guard", {});
}
void checkProvisionCalls;

describe("worker provider SDK version contract", () => {
  it("keeps the public legacy default separate from the registered union", () => {
    expectTypeOf<WorkerProvider<1>>().toEqualTypeOf<WorkerProviderV1>();
    expectTypeOf<
      Parameters<OpenClawPluginApi["registerWorkerProvider"]>[0]
    >().toEqualTypeOf<RegisteredWorkerProvider>();
    expectTypeOf<Parameters<WorkerProvider<1>["provision"]>[2]["assertCurrent"]>().toEqualTypeOf<
      () => void
    >();
    expectTypeOf<
      Parameters<NonNullable<WorkerProvider<1>["resolveSshIdentity"]>>[0]["assertCurrent"]
    >().toEqualTypeOf<() => void>();
  });
});
