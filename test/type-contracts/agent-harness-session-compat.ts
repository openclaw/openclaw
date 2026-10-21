import { expectTypeOf } from "vitest";
import type {
  captureNativeSessionGenerationAuthority,
  createNativeSessionInitializationOwner,
  resolveNativeSessionBinding,
  NativeSessionGenerationOperations,
  NativeSessionGenerationOperationsV2,
  NativeSessionBindingAuthority,
} from "../../src/plugin-sdk/agent-harness-session-runtime.js";

// Retains the native-session signatures consumed by released official harnesses.
expectTypeOf<ReturnType<typeof captureNativeSessionGenerationAuthority>>().toEqualTypeOf<{
  state: "current" | "ephemeral" | "superseded";
  previousSessionId: string | undefined;
  assertHostCurrent: () => void;
  assertCurrent: (this: void) => void;
}>();
expectTypeOf<Awaited<ReturnType<typeof resolveNativeSessionBinding<string>>>>().toEqualTypeOf<{
  binding: string | undefined;
  assertCurrent: () => void;
}>();
expectTypeOf<Parameters<NativeSessionGenerationOperations["adopt"]>>().toEqualTypeOf<
  [expectedPreviousSessionId: string, assertCurrent: () => void]
>();
expectTypeOf<Parameters<NativeSessionGenerationOperations["reclaim"]>>().toEqualTypeOf<
  [expectedPreviousSessionId: string, assertCurrent: () => void]
>();
expectTypeOf<Parameters<NativeSessionGenerationOperationsV2["adopt"]>>().toEqualTypeOf<
  [expectedPreviousSessionId: string, authority: NativeSessionBindingAuthority]
>();
expectTypeOf<Parameters<NativeSessionGenerationOperationsV2["reclaim"]>>().toEqualTypeOf<
  [expectedPreviousSessionId: string, authority: NativeSessionBindingAuthority]
>();

// Retains synchronous released initialization links alongside awaited links.
type Owner = ReturnType<typeof createNativeSessionInitializationOwner>;
type Initialization = ReturnType<Owner["prepare"]>;
expectTypeOf<ReturnType<Initialization["link"]>>().toEqualTypeOf<void>();
expectTypeOf<ReturnType<Initialization["linkAsync"]>>().toEqualTypeOf<Promise<void>>();
expectTypeOf<Parameters<Initialization["linkAsync"]>>().toEqualTypeOf<
  Parameters<Initialization["link"]>
>();
