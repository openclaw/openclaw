import type {
  readChannelAllowFromStore,
  readChannelAllowFromStoreSync,
} from "openclaw/plugin-sdk/channel-pairing";
import { expectTypeOf, it } from "vitest";

it("retains both released pairing allowlist signatures", () => {
  expectTypeOf<typeof readChannelAllowFromStoreSync>().toExtend<
    (channel: string, env?: NodeJS.ProcessEnv, accountId?: string) => string[]
  >();
  expectTypeOf<typeof readChannelAllowFromStore>().toExtend<
    (channel: string, env?: NodeJS.ProcessEnv, accountId?: string) => Promise<string[]>
  >();
  expectTypeOf<ReturnType<typeof readChannelAllowFromStoreSync>>().toEqualTypeOf<string[]>();
  expectTypeOf<ReturnType<typeof readChannelAllowFromStore>>().toEqualTypeOf<Promise<string[]>>();
});
