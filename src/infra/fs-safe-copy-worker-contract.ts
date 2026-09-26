import type { CloneFileMetadata, TreeCloneBackend } from "@openclaw/fs-safe/copy";
export type { CloneFileMetadata } from "@openclaw/fs-safe/copy";

export type FsSafeCopyRead =
  | { type: "probe"; parent: string }
  | { type: "metadata"; paths: string[] };

export type FsSafeCopyWrite =
  | { type: "create"; destination: string }
  | { type: "copy"; source: string; destination: string };

export type FsSafeCopyReply =
  | { type: "probe"; backend: TreeCloneBackend | undefined }
  | { type: "metadata"; entries: (CloneFileMetadata | undefined)[] }
  | { type: "written" }
  | { type: "failed"; message: string; code?: string };
