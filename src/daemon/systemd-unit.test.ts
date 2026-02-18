import { describe, expect, it } from "vitest";
import { buildSystemdUnit } from "./systemd-unit.js";

describe("buildSystemdUnit", () => {
  it("uses KillMode=process by default", () => {
    const unit = buildSystemdUnit({
      programArguments: ["/usr/bin/node", "/tmp/openclaw/dist/index.js", "gateway"],
    });
    expect(unit).toContain("KillMode=process");
  });

  it("supports KillMode=mixed", () => {
    const unit = buildSystemdUnit({
      programArguments: ["/usr/bin/node", "/tmp/openclaw/dist/index.js", "gateway"],
      killMode: "mixed",
    });
    expect(unit).toContain("KillMode=mixed");
  });

  it("supports KillMode=control-group", () => {
    const unit = buildSystemdUnit({
      programArguments: ["/usr/bin/node", "/tmp/openclaw/dist/index.js", "gateway"],
      killMode: "control-group",
    });
    expect(unit).toContain("KillMode=control-group");
  });
});
