// A narrow browser-D transport relay. No Gateway key participates in device authentication.
import { isDeepStrictEqual } from "node:util";
import {
  verifyDiscoveryRequest,
  deviceMailRoute,
  type DeviceMailRequest,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { readResponseWithLimit } from "../../infra/http-response-body.js";

/** Forwards authenticated D-signed bytes unchanged to configured Discovery, with no redirect. */
export async function relayDeviceMail(params: {
  baseUrl: string;
  clawId: string;
  request: DeviceMailRequest;
  activeCertificates: SignedStatement<"OwnerDeviceCert">[];
  signal?: AbortSignal;
}) {
  const r = params.request;
  if (
    typeof r.body !== "string" ||
    Buffer.byteLength(r.body) > 65_536 ||
    typeof r.idToken !== "string" ||
    r.idToken.length > 16_384 ||
    !r.idToken ||
    typeof r.signature !== "string" ||
    r.signature.length > 2_048 ||
    !params.activeCertificates.some((cert) => isDeepStrictEqual(cert, r.certificate))
  ) {
    throw new Error("an active owner device and bounded signed request are required");
  }
  const route = deviceMailRoute(r.operation, params.clawId, r.after);
  if (route.method === "GET" && r.body !== "") {
    throw new Error("a mailbox read has no body");
  }
  const bytes = new TextEncoder().encode(r.body);
  const verified = await verifyDiscoveryRequest(
    { ...route, body: bytes },
    r.signature,
    Math.floor(Date.now() / 1000),
  );
  if (!verified.ok || verified.keyid !== r.certificate.body.device_pub) {
    throw new Error("request must be signed by this active owner device");
  }
  // Only public certificate data supplements the existing device/account authentication.
  const headers = {
    authorization: `Bearer ${r.idToken}`,
    "openclaw-signature": r.signature,
    "openclaw-owner-certificate": JSON.stringify(r.certificate).replace(
      /[^\x20-\x7e]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
    "content-type": "application/json",
  };
  const response = await fetch(`${params.baseUrl.replace(/\/+$/, "")}${route.path}`, {
    method: route.method,
    headers,
    redirect: "error",
    ...(route.method === "POST" ? { body: r.body } : {}),
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(25_000)])
      : AbortSignal.timeout(25_000),
  });
  const body = (
    await readResponseWithLimit(response, 1_048_576, { signal: params.signal, timeoutMs: 5_000 })
  ).toString("utf8");
  return { status: response.status, body };
}
