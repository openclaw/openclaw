import type {
  getSessionEntry,
  patchSessionEntry,
  SessionEntry,
  updateSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { expectTypeOf, it } from "vitest";

it("retains released session-store callbacks alongside prepared replacements", () => {
  type Patch = Parameters<typeof patchSessionEntry>[0];
  expectTypeOf<Patch["update"]>().toEqualTypeOf<
    (
      entry: SessionEntry,
      context: { existingEntry?: SessionEntry },
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null
  >();
  expectTypeOf<Patch["assertCommitAllowed"]>().toEqualTypeOf<(() => void) | undefined>();
  expectTypeOf<ReturnType<NonNullable<Patch["assertCommitAllowed"]>>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<typeof updateSessionStoreEntry>[0]["update"]>().toEqualTypeOf<
    (entry: SessionEntry) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null
  >();
  expectTypeOf<ReturnType<typeof getSessionEntry>>().toEqualTypeOf<SessionEntry | undefined>();
  expectTypeOf<ReturnType<typeof patchSessionEntry>>().toEqualTypeOf<
    Promise<SessionEntry | null>
  >();
  expectTypeOf<ReturnType<typeof updateSessionStoreEntry>>().toEqualTypeOf<
    Promise<SessionEntry | null>
  >();
});
