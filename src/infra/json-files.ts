import "./fs-safe-defaults.js";
export {
  JsonFileReadError,
  readJson,
  readJson as readJsonFileStrict,
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile,
  readJsonSync,
  tryReadJson,
  tryReadJson as readJsonFile,
  tryReadJsonSync as readJsonFileSync,
  writeJson,
  writeJson as writeJsonAtomic,
} from "@openclaw/fs-safe/json";
export { writeTextAtomic } from "@openclaw/fs-safe/atomic";
export { createAsyncLock } from "@openclaw/fs-safe/advanced";
