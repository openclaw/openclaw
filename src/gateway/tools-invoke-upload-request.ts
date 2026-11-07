import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayUploadRequest } from "./upload-policy.js";

/** New client bytes, not a request to deliver a file already owned by the Gateway. */
export function isToolUploadRequest(toolName: string, args: unknown): boolean {
  if (!isRecord(args)) {
    return false;
  }
  switch (toolName) {
    case "file_write":
      return typeof args.contentBase64 === "string";
    case "workboard_attachment_add":
      return true;
    case "message":
      return isGatewayUploadRequest("message.action", { params: args });
    default:
      return false;
  }
}
