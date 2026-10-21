import path from "node:path";
import type { PublicationFixture } from "./sqlite-snapshot.test-support.js";

type Durability = typeof import("@openclaw/fs-safe/durability");
export type SnapshotDurabilityState = {
  hashedBytes: number;
  measure?: boolean;
  publish?: PublicationFixture;
  transfer?: PublicationFixture;
  publicationSyncUnsupported?: boolean;
  syncOutcome?: { status: "synced" } | { status: "unsupported"; code?: string };
  sync?: Durability["syncDirectory"];
  originalSync?: Durability["syncDirectory"];
};

export function mockSnapshotDurability(actual: Durability, state: SnapshotDurabilityState) {
  state.originalSync = actual.syncDirectory;
  return {
    ...actual,
    sha256File: async (...args: Parameters<Durability["sha256File"]>) => {
      const result = await actual.sha256File(...args);
      if (state.measure) {
        state.hashedBytes += result.bytes;
      }
      return result;
    },
    publishFileExclusive: async (...args: Parameters<Durability["publishFileExclusive"]>) => {
      if (path.basename(path.dirname(args[0].targetPath)).startsWith(".sqlite-publish-")) {
        return state.transfer
          ? state.transfer(args[0], actual.publishFileExclusive)
          : actual.publishFileExclusive(...args);
      }
      const published = state.publish
        ? await state.publish(args[0], actual.publishFileExclusive)
        : await actual.publishFileExclusive(...args);
      return state.publicationSyncUnsupported
        ? { ...published, directorySync: { status: "unsupported" as const, code: "ENOTSUP" } }
        : published;
    },
    syncDirectory: async (...args: Parameters<Durability["syncDirectory"]>) =>
      state.syncOutcome ?? (await (state.sync ?? actual.syncDirectory)(...args)),
  };
}

export function resetSnapshotDurability(state: SnapshotDurabilityState) {
  state.publish = state.transfer = state.sync = state.syncOutcome = undefined;
  state.publicationSyncUnsupported = state.measure = false;
  state.hashedBytes = 0;
}
