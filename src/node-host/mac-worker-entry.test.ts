import { describe, expect, it } from "vitest";
import { resolveMacNodeWorkerArgv } from "./mac-worker-entry.js";

describe("Mac node worker entry", () => {
  it("accepts only the private worker command while preserving profile selection", () => {
    expect(
      resolveMacNodeWorkerArgv([
        "/runtime/bin/node",
        "/runtime/openclaw/dist/mac-node-worker.js",
        "--profile",
        "work",
        "node",
        "worker",
      ]),
    ).toEqual({
      ok: true,
      profile: "work",
      argv: ["/runtime/bin/node", "/runtime/openclaw/dist/mac-node-worker.js", "node", "worker"],
    });
  });

  it("rejects the rest of the OpenClaw CLI surface", () => {
    expect(
      resolveMacNodeWorkerArgv([
        "/runtime/bin/node",
        "/runtime/openclaw/dist/mac-node-worker.js",
        "gateway",
      ]),
    ).toEqual({ ok: false, error: "Private macOS worker accepts only: node worker" });
  });
});
