import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProfileEnrollmentParams } from "../api/gateway-profile-enrollment.ts";
import { generateUUID } from "../lib/uuid.ts";
import type { NativeProfileEnrollmentResult } from "./native-gateway-auth.ts";

/** Optional operation; native challenge signing does not load enrollment parsing or copy. */
export function enrollNativeProfile(
  send: <T>(
    request: { id: string; action: "enrollProfile"; params: ProfileEnrollmentParams },
    signal: AbortSignal,
    readResult: (value: unknown) => T,
  ) => Promise<T>,
  params: ProfileEnrollmentParams,
  signal: AbortSignal,
): Promise<NativeProfileEnrollmentResult> {
  return send({ id: generateUUID(), action: "enrollProfile", params }, signal, (value) => {
    if (
      !isRecord(value) ||
      typeof value.deviceId !== "string" ||
      typeof value.profileId !== "string" ||
      typeof value.reconnect !== "boolean" ||
      "operatorToken" in value
    ) {
      throw new Error(
        "The app returned an invalid personal setup result. Reconnect and check Profile.",
      );
    }
    return { deviceId: value.deviceId, profileId: value.profileId, reconnect: value.reconnect };
  });
}
