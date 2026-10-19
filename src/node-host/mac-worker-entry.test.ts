import { describe, expect, it } from "vitest";
import { resolveMacNodeWorkerArgv } from "./mac-worker-entry.js";

describe("Mac node worker entry", () => {
  it.each([
    { args: [], enabled: undefined },
    { args: ["--desktop-sharing"], enabled: true },
    { args: ["--no-desktop-sharing"], enabled: false },
    { args: ["--desktop-sharing", "--no-desktop-sharing"], enabled: false },
    { args: ["--no-desktop-sharing", "--desktop-sharing"], enabled: true },
  ])("preserves profile and desktop preference for $args", ({ args, enabled }) => {
    expect(
      resolveMacNodeWorkerArgv([
        "/runtime/bin/node",
        "/runtime/openclaw/dist/mac-node-worker.js",
        "--profile",
        "work",
        "node",
        "worker",
        ...args,
      ]),
    ).toEqual({
      ok: true,
      profile: "work",
      argv: [
        "/runtime/bin/node",
        "/runtime/openclaw/dist/mac-node-worker.js",
        "node",
        "worker",
        ...args,
      ],
      desktopSharingEnabled: enabled,
    });
  });

  it.each([
    ["gateway"],
    ["node", "run"],
    ["node", "worker", "--host", "localhost"],
    ["node", "worker", "extra"],
  ])("rejects unrelated command arguments %s", (...args) => {
    expect(
      resolveMacNodeWorkerArgv([
        "/runtime/bin/node",
        "/runtime/openclaw/dist/mac-node-worker.js",
        ...args,
      ]),
    ).toEqual({ ok: false, error: "Private macOS worker accepts only: node worker" });
  });
});
