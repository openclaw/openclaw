type JsonRecord = Record<string, unknown>;
import { isRecord } from "../../../utils.js";
export type { JsonRecord };
export { isRecord };
export declare function cloneRecord<T extends JsonRecord>(value: T | undefined): T;
export declare function ensureRecord(target: JsonRecord, key: string): JsonRecord;
export declare function hasOwnKey(target: JsonRecord, key: string): boolean;
