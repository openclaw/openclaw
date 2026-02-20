import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

export type ManifestFileEntry = {
  path: string;
  hash: string;
  fileId: string;
  vectorStoreFileId?: string;
  uploadedAt: number;
};

export type ManifestData = {
  vectorStoreId: string;
  files: ManifestFileEntry[];
};

export class RemoteManifest {
  private data: ManifestData;
  private dirty = false;

  private constructor(
    private readonly filePath: string,
    data: ManifestData,
  ) {
    this.data = data;
  }

  static async load(manifestPath: string, vectorStoreId: string): Promise<RemoteManifest> {
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as ManifestData;
      if (parsed.vectorStoreId !== vectorStoreId) {
        log.warn("manifest vector store ID mismatch; resetting manifest");
        return new RemoteManifest(manifestPath, { vectorStoreId, files: [] });
      }
      return new RemoteManifest(manifestPath, parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`failed to load remote manifest: ${String(err)}`);
      }
      return new RemoteManifest(manifestPath, { vectorStoreId, files: [] });
    }
  }

  get vectorStoreId(): string {
    return this.data.vectorStoreId;
  }

  set vectorStoreId(id: string) {
    if (this.data.vectorStoreId !== id) {
      this.data.vectorStoreId = id;
      this.data.files = [];
      this.dirty = true;
    }
  }

  getEntry(filePath: string): ManifestFileEntry | undefined {
    return this.data.files.find((f) => f.path === filePath);
  }

  getAllEntries(): ManifestFileEntry[] {
    return [...this.data.files];
  }

  upsert(entry: ManifestFileEntry): void {
    const idx = this.data.files.findIndex((f) => f.path === entry.path);
    if (idx >= 0) {
      this.data.files[idx] = entry;
    } else {
      this.data.files.push(entry);
    }
    this.dirty = true;
  }

  remove(filePath: string): ManifestFileEntry | undefined {
    const idx = this.data.files.findIndex((f) => f.path === filePath);
    if (idx < 0) {
      return undefined;
    }
    const [removed] = this.data.files.splice(idx, 1);
    this.dirty = true;
    return removed;
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    this.dirty = false;
  }
}
