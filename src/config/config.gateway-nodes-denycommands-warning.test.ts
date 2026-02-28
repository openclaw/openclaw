import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

describe("config: gateway.nodes.denyCommands warnings", () => {
  it("warns when denyCommands includes pattern-like entries", () => {
    const res = validateConfigObjectWithPlugins({
      gateway: {
        nodes: {
          denyCommands: ["system.*"],
        },
      },
    });

    expect(res.warnings.some((w) => w.path === "gateway.nodes.denyCommands")).toBe(true);
  });

  it("warns when denyCommands includes unknown command names", () => {
    const res = validateConfigObjectWithPlugins({
      gateway: {
        nodes: {
          denyCommands: ["system.runx"],
        },
      },
    });

    expect(res.warnings.some((w) => w.path === "gateway.nodes.denyCommands")).toBe(true);
    const warning = res.warnings.find((w) => w.path === "gateway.nodes.denyCommands");
    expect(warning?.message).toContain("Unknown");
  });

  it("does not warn for valid exact command names", () => {
    const res = validateConfigObjectWithPlugins({
      gateway: {
        nodes: {
          denyCommands: ["camera.snap", "screen.record"],
        },
      },
    });

    expect(res.warnings.some((w) => w.path === "gateway.nodes.denyCommands")).toBe(false);
  });
});
