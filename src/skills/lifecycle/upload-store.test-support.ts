import type { SkillUploadStore } from "./upload-store.js";
import "./upload-store.js";

type SkillUploadStoreTestApi = {
  createSkillUploadStore(options?: {
    rootDir?: string;
    now?: () => number;
    ttlMs?: number;
  }): SkillUploadStore;
};

function getTestApi(): SkillUploadStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.skillUploadStoreTestApi")
  ] as SkillUploadStoreTestApi;
}

export function createSkillUploadStore(
  options?: Parameters<SkillUploadStoreTestApi["createSkillUploadStore"]>[0],
): SkillUploadStore {
  return getTestApi().createSkillUploadStore(options);
}
