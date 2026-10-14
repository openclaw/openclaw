import type {
  deleteSessionUpstreamLink,
  deleteSessionUpstreamLinkAsync,
  upsertSessionUpstreamLink,
  upsertSessionUpstreamLinkAsync,
  SessionUpstreamJsonValue,
  SessionUpstreamKind,
} from "openclaw/plugin-sdk/session-catalog";
import { expectTypeOf, it } from "vitest";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

it("retains v2026.9.8 upstream-link write signatures with awaited replacements", () => {
  type ReleasedInput = {
    sessionKey: string;
    agentId: string;
    catalogId: string;
    hostId: string;
    threadId: string;
    upstreamKind: SessionUpstreamKind;
    upstreamRef: SessionUpstreamJsonValue;
    marker: SessionUpstreamJsonValue | null;
  };
  type ReleasedLink = ReleasedInput & {
    lastScannedAt?: number;
    createdAt: number;
    updatedAt: number;
  };
  type ReleasedUpsert = (
    input: ReleasedInput,
    options?: OpenClawStateDatabaseOptions & {
      now?: number;
      ifAbsent?: true;
      assertCommitAllowed?: () => void;
    },
  ) => boolean;
  type ReleasedDelete = (
    sessionKey: string,
    agentId: string,
    options?: OpenClawStateDatabaseOptions & {
      expected?: ReleasedLink;
      assertCommitAllowed?: () => void;
    },
  ) => "deleted" | "absent" | "changed" | undefined;

  expectTypeOf<typeof upsertSessionUpstreamLink>().toExtend<ReleasedUpsert>();
  expectTypeOf<typeof deleteSessionUpstreamLink>().toExtend<ReleasedDelete>();
  expectTypeOf<ReturnType<typeof upsertSessionUpstreamLink>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReturnType<typeof deleteSessionUpstreamLink>>().toEqualTypeOf<
    ReturnType<ReleasedDelete>
  >();
  expectTypeOf<typeof upsertSessionUpstreamLinkAsync>().toExtend<
    (...args: Parameters<ReleasedUpsert>) => Promise<boolean>
  >();
  expectTypeOf<typeof deleteSessionUpstreamLinkAsync>().toExtend<
    (...args: Parameters<ReleasedDelete>) => Promise<ReturnType<ReleasedDelete>>
  >();
  expectTypeOf<ReturnType<typeof upsertSessionUpstreamLinkAsync>>().toEqualTypeOf<
    Promise<boolean>
  >();
  expectTypeOf<ReturnType<typeof deleteSessionUpstreamLinkAsync>>().toEqualTypeOf<
    Promise<ReturnType<ReleasedDelete>>
  >();
});
