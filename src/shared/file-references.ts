export * from "../../packages/gateway-protocol/src/file-reference-limits.js";
export type {
  FileReference,
  FileReferenceCapability,
  FileReferenceContext,
  FileReferenceResult,
  SessionsFilesReferencesParams,
} from "../../packages/gateway-protocol/src/schema/sessions-file-references.js";
export {
  isFileReference,
  isFileReferenceCapability,
  isFileReferenceResult,
} from "../../packages/gateway-protocol/src/compiled/file-reference.js";
