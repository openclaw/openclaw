import { expect } from "vitest";

export function expectSignedPayloadFields(
  payload: string | undefined,
  params: { scopes: string[]; token: string; nonce: string; signedAtMs?: number },
) {
  expect(payload?.split("|")).toEqual([
    "v2",
    "device-1",
    "openclaw-control-ui",
    "webchat",
    "operator",
    params.scopes.join(","),
    params.signedAtMs === undefined ? expect.stringMatching(/^\d+$/) : String(params.signedAtMs),
    params.token,
    params.nonce,
  ]);
}
