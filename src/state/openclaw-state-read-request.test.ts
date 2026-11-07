import { expect, it, vi } from "vitest";
import { requestBytes } from "./openclaw-state-read-request.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";

it("preserves admission charges for every UTF-16 code unit and surrogate boundary", () => {
  const request: OpenClawStateReadRequest = {
    context: { environment: { OPENCLAW_STATE_DIR: "/s" } },
    databasePath: "/s/db",
    location: "/s/db",
    checkFreshAdmission: false,
    command: { type: "machineState.read", input: { key: "" } },
  };
  const check = (key: string) => {
    request.command = { type: "machineState.read", input: { key } };
    // Field names, slots, type, environment and paths contribute 85 bytes.
    expect(requestBytes(request)).toBe(85 + Buffer.byteLength(JSON.stringify(key)));
  };
  for (let code = 0; code <= 0xffff; code++) {
    check(String.fromCharCode(code));
  }
  for (const key of [
    "",
    "plain ASCII",
    '"\\\b\t\n\f\r\u0000',
    "中🦞",
    "\ud800\ud800",
    "\udfff\udfff",
    "\udfff\ud800",
    "\ud800\udfff",
    "\udbff\udc00",
    "\ud800x\udfff",
  ]) {
    check(key);
  }
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    requestBytes(request);
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});
