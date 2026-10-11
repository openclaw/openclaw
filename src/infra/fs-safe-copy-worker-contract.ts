import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import type { CloneFileMetadata, TreeCloneBackend } from "@openclaw/fs-safe/copy";
import type { DarwinAclInspection } from "@openclaw/fs-safe/permissions";
export type { CloneFileMetadata } from "@openclaw/fs-safe/copy";

export type FsSafeCopyRead =
  | { type: "probe"; parent: string }
  | { type: "acl"; path: string }
  | { type: "metadata"; paths: string[] };

export type FsSafeCopyWrite =
  | { type: "create"; destination: string }
  | { type: "copy"; source: string; destination: string };

export type FsSafeCopyReply =
  | { type: "probe"; backend: TreeCloneBackend | undefined; nativeMode: FsSafeNativeMode }
  | { type: "metadata"; entries: (CloneFileMetadata | undefined)[] }
  | { type: "acl"; acl: DarwinAclInspection }
  | { type: "written" }
  | { type: "failed"; message: string; code?: string };
