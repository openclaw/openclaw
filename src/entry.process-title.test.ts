import { describe, expect, it } from "vitest";
import { resolveEntryProcessTitle } from "./entry.process-title.js";

describe("resolveEntryProcessTitle", () => {
  it("marks native hook relays before CLI bootstrap", () => {
    expect(
      resolveEntryProcessTitle([
        "/usr/bin/node",
        "/opt/openclaw/dist/entry.js",
        "hooks",
        "relay",
        "--provider",
        "codex",
      ]),
    ).toBe("openclaw-hooks");
  });

  it("recognizes hook relays after root options", () => {
    expect(
      resolveEntryProcessTitle([
        "/usr/bin/node",
        "/opt/openclaw/dist/entry.js",
        "--profile",
        "work",
        "hooks",
        "relay",
      ]),
    ).toBe("openclaw-hooks");
  });

  it("keeps other hook commands on the normal CLI title", () => {
    expect(
      resolveEntryProcessTitle(["/usr/bin/node", "/opt/openclaw/dist/entry.js", "hooks", "list"]),
    ).toBe("openclaw");
  });
});
