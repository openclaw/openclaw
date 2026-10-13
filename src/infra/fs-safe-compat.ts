import type { Root as FsSafeRoot } from "@openclaw/fs-safe/root";
import type { FileStore as FsSafeFileStore } from "@openclaw/fs-safe/store";
import {
  tempWorkspace as fsSafeTempWorkspace,
  withTempWorkspace as fsSafeWithTempWorkspace,
  type TempWorkspace as FsSafeTempWorkspace,
} from "@openclaw/fs-safe/temp";

export type LegacyNonBlockingReadOption = {
  /** @deprecated Omit this hint; safe reads always use nonblocking admission where supported. */
  nonBlockingRead?: boolean;
};

type WithLegacyReadHint<Method> = Method extends (
  path: infer Path,
  options?: infer Options,
) => infer Result
  ? (path: Path, options?: NonNullable<Options> & LegacyNonBlockingReadOption) => Result
  : never;

type CompatibleRootReadMethods = {
  [Method in "open" | "read" | "readBytes" | "readText" | "readAbsolute"]: WithLegacyReadHint<
    FsSafeRoot[Method]
  >;
};

// Keep the full vendor Root here; individual SDK owners retain their existing capability limits.
export type CompatibleFsSafeRoot = Omit<
  FsSafeRoot,
  keyof CompatibleRootReadMethods | "defaults" | "readJson" | "reader"
> &
  CompatibleRootReadMethods & {
    readonly defaults: FsSafeRoot["defaults"] & LegacyNonBlockingReadOption;
    readJson<T = unknown>(
      path: Parameters<FsSafeRoot["readJson"]>[0],
      options?: NonNullable<Parameters<FsSafeRoot["readJson"]>[1]> & LegacyNonBlockingReadOption,
    ): Promise<T>;
    reader(
      options?: NonNullable<Parameters<FsSafeRoot["reader"]>[0]> & LegacyNonBlockingReadOption,
    ): ReturnType<FsSafeRoot["reader"]>;
  };

type CompatibleStoreReadMethods = {
  [Method in "open" | "read" | "readBytes" | "readText" | "readTextIfExists"]: WithLegacyReadHint<
    FsSafeFileStore[Method]
  >;
};

type CompatibleFileStore = Omit<
  FsSafeFileStore,
  keyof CompatibleStoreReadMethods | "root" | "readJson" | "readJsonIfExists"
> &
  CompatibleStoreReadMethods & {
    root(): Promise<CompatibleFsSafeRoot>;
    readJson<T = unknown>(
      path: Parameters<FsSafeFileStore["readJson"]>[0],
      options?: NonNullable<Parameters<FsSafeFileStore["readJson"]>[1]> &
        LegacyNonBlockingReadOption,
    ): Promise<T>;
    readJsonIfExists<T = unknown>(
      path: Parameters<FsSafeFileStore["readJsonIfExists"]>[0],
      options?: NonNullable<Parameters<FsSafeFileStore["readJsonIfExists"]>[1]> &
        LegacyNonBlockingReadOption,
    ): Promise<T | null>;
  };

export type CompatibleTempWorkspace = Omit<FsSafeTempWorkspace, "store"> & {
  store: CompatibleFileStore;
};

// Preserve the shipped async workspace options without wrapping native operations.
export const tempWorkspace: (
  options: Parameters<typeof fsSafeTempWorkspace>[0],
) => Promise<CompatibleTempWorkspace> = fsSafeTempWorkspace;
export const withTempWorkspace: <T>(
  options: Parameters<typeof fsSafeTempWorkspace>[0],
  run: (workspace: CompatibleTempWorkspace) => Promise<T>,
) => Promise<T> = fsSafeWithTempWorkspace;
