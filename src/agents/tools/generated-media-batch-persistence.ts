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
  let firstFailure: { error: unknown } | undefined;
  const savedMedia: Array<SavedMedia | undefined> = [];
  const runSave = async (save: () => Promise<GeneratedMediaSave<T>>, index: number) => {
    try {
      const result = await save();
      savedMedia[index] = result.savedMedia;
      return result.value;
    } catch (error) {
      firstFailure ??= { error };
      throw error;
    }
  };

  let values: T[];
  if (params.mode === "concurrent") {
    const settled = await Promise.allSettled(
      params.saves.map((save, index) => runSave(save, index)),
    );
    values = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
  } else {
    values = [];
    for (const [index, save] of params.saves.entries()) {
      try {
        values.push(await runSave(save, index));
      } catch {
        break;
      }
    }
  }

  if (firstFailure) {
    // Concurrent batches must drain sibling writes before cleanup so a late
    // success cannot escape rollback after the caller observes failure.
    await Promise.allSettled(
      savedMedia.flatMap((saved) =>
        saved ? [Promise.resolve().then(() => deleteMediaBuffer(saved.id, params.subdir))] : [],
      ),
    );
    throw firstFailure.error;
  }

  return values;
}
