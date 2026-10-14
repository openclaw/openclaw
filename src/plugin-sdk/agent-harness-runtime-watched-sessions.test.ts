import type {
  buildWatchedSessionsHarnessContext,
  prepareWatchedSessionsHarnessContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expectTypeOf, it } from "vitest";

it("retains the released synchronous result and requires authority for async preparation", () => {
  type LegacyParams = Parameters<typeof buildWatchedSessionsHarnessContext>[0];
  type PreparedParams = Parameters<typeof prepareWatchedSessionsHarnessContext>[0];

  expectTypeOf<ReturnType<typeof buildWatchedSessionsHarnessContext>>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<ReturnType<typeof prepareWatchedSessionsHarnessContext>>().toEqualTypeOf<
    Promise<string | undefined>
  >();
  expectTypeOf<Omit<PreparedParams, "assertCurrent">>().toEqualTypeOf<LegacyParams>();
  expectTypeOf<LegacyParams>().not.toExtend<PreparedParams>();
  expectTypeOf<PreparedParams["assertCurrent"]>().toEqualTypeOf<() => void>();
});
