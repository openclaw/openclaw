import type { ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import { sendJson } from "./http-common.js";
import {
  areGatewayUploadsEnabled,
  GATEWAY_UPLOADS_DISABLED_CODE,
  GATEWAY_UPLOADS_DISABLED_MESSAGE,
} from "./upload-policy.js";

/** Recheck the current client-upload policy before HTTP media preparation and dispatch. */
export function rejectDisabledGatewayUpload(res: ServerResponse, hasMedia: boolean): boolean {
  if (!hasMedia || areGatewayUploadsEnabled(getRuntimeConfig())) {
    return false;
  }
  sendJson(res, 403, {
    error: {
      message: GATEWAY_UPLOADS_DISABLED_MESSAGE,
      type: "forbidden",
      code: GATEWAY_UPLOADS_DISABLED_CODE,
    },
  });
  return true;
}
