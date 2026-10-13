import { expectTypeOf, it } from "vitest";
import type { createNativeSessionInitializationOwner } from "./agent-harness-session-runtime.js";

it("retains synchronous released initialization links alongside awaited links", () => {
  type Owner = ReturnType<typeof createNativeSessionInitializationOwner>;
  type Initialization = ReturnType<Owner["prepare"]>;
  expectTypeOf<ReturnType<Initialization["link"]>>().toEqualTypeOf<void>();
  expectTypeOf<ReturnType<Initialization["linkAsync"]>>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<Parameters<Initialization["linkAsync"]>>().toEqualTypeOf<
    Parameters<Initialization["link"]>
  >();
});
