import type { Root } from "@openclaw/fs-safe/root";

export class ObservationSampleCloseError extends Error {
  constructor(cause: unknown) {
    super("File observation metadata handle cleanup failed", { cause });
  }
}

export async function readObservationSnapshot(
  authority: Root,
  relative: string,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  let opened: Awaited<ReturnType<Root["open"]>>;
  try {
    // Sample only admitted regular files; missing or rejected paths still dirty the owner.
    opened = await authority.open("./" + relative, { symlinks: "reject" });
  } catch {
    return undefined;
  }
  try {
    await opened[Symbol.asyncDispose]();
  } catch (error) {
    throw new ObservationSampleCloseError(error);
  }
  return { size: opened.stat.size, mtimeMs: opened.stat.mtimeMs };
}
