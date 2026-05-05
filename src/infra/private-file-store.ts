import "./fs-safe-defaults.js";
import { privateStateStore, type PrivateStateStore } from "@openclaw/fs-safe/advanced";

export {
  readPrivateJson,
  readPrivateJsonSync,
  readPrivateText,
  readPrivateTextSync,
  writePrivateJsonAtomic,
  writePrivateJsonAtomicSync,
  writePrivateTextAtomic,
  writePrivateTextAtomicSync,
  type PrivateStateStore as PrivateFileStore,
} from "@openclaw/fs-safe/advanced";

export function privateFileStore(rootDir: string): PrivateStateStore {
  return privateStateStore({ rootDir });
}
