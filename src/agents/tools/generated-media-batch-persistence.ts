import { deleteMediaBuffer, saveMediaBuffer, type SavedMedia } from "../../media/store.js";

type GeneratedMediaSave<T> = {
  value: T;
  savedMedia?: SavedMedia;
};

type GeneratedMediaSaveMode = "concurrent" | "sequential";

export function persistGeneratedMediaBuffers(params: {
  assets: readonly { buffer: Buffer; mimeType: string; fileName?: string }[];
  subdir: string;
  maxBytes: number;
  filename?: string;
}): Promise<SavedMedia[]> {
  return persistGeneratedMediaBatch({
    subdir: params.subdir,
    mode: "concurrent",
    saves: params.assets.map((asset) => async () => {
      const savedMedia = await saveMediaBuffer(
        asset.buffer,
        asset.mimeType,
        params.subdir,
        params.maxBytes,
        params.filename || asset.fileName,
      );
      return { value: savedMedia, savedMedia };
    }),
  });
}

/** Gives generated-media batches all-or-nothing result semantics with best-effort rollback. */
export async function persistGeneratedMediaBatch<T>(params: {
  subdir: string;
  saves: ReadonlyArray<() => Promise<GeneratedMediaSave<T>>>;
  mode: GeneratedMediaSaveMode;
}): Promise<T[]> {
  const savedMedia: Array<SavedMedia | undefined> = [];
  const runSave = async (save: () => Promise<GeneratedMediaSave<T>>, index: number) => {
    const result = await save();
    savedMedia[index] = result.savedMedia;
    return result.value;
  };
  let pending: Promise<T>[] = [];
  try {
    if (params.mode === "concurrent") {
      pending = params.saves.map(runSave);
      return await Promise.all(pending);
    }
    const values: T[] = [];
    for (const [index, save] of params.saves.entries()) {
      values.push(await runSave(save, index));
    }
    return values;
  } catch (error) {
    // Concurrent batches must drain sibling writes before cleanup so a late
    // success cannot escape rollback after the caller observes failure.
    await Promise.allSettled(pending);
    await Promise.allSettled(
      savedMedia.flatMap((saved) =>
        saved ? [Promise.resolve().then(() => deleteMediaBuffer(saved.id, params.subdir))] : [],
      ),
    );
    throw error;
  }
}
