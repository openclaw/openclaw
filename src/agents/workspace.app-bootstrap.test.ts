import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyAppBootstrapVariants } from "./workspace.js";

type BootFiles = Parameters<typeof applyAppBootstrapVariants>[0];

describe("applyAppBootstrapVariants (app-user bootstrap shaping)", () => {
  it("drops boilerplate files and swaps content from <name>.app.md when present", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appboot-"));
    await fs.writeFile(path.join(dir, "AGENTS.app.md"), "LEAN AGENTS", "utf8");
    const files: BootFiles = [
      {
        name: "AGENTS.md",
        path: path.join(dir, "AGENTS.md"),
        content: "FULL AGENTS",
        missing: false,
      },
      { name: "SOUL.md", path: path.join(dir, "SOUL.md"), content: "FULL SOUL", missing: false },
      {
        name: "BOOTSTRAP.md",
        path: path.join(dir, "BOOTSTRAP.md"),
        content: "boot",
        missing: false,
      },
      { name: "TOOLS.md", path: path.join(dir, "TOOLS.md"), content: "tools", missing: false },
      { name: "USER.md", path: path.join(dir, "USER.md"), content: "user", missing: false },
      { name: "MEMORY.md", path: path.join(dir, "MEMORY.md"), content: "mem", missing: false },
      { name: "HEARTBEAT.md", path: path.join(dir, "HEARTBEAT.md"), content: "hb", missing: false },
      { name: "IDENTITY.md", path: path.join(dir, "IDENTITY.md"), content: "id", missing: false },
    ];
    const out = await applyAppBootstrapVariants(files, dir);
    const byName = Object.fromEntries(out.map((f) => [f.name, f.content]));

    // Boilerplate dropped; AGENTS/SOUL/BOOTSTRAP kept.
    expect(out.map((f) => f.name).toSorted()).toEqual(["AGENTS.md", "BOOTSTRAP.md", "SOUL.md"]);
    // AGENTS.md content swapped from the lean variant; SOUL.md (no variant) kept verbatim.
    expect(byName["AGENTS.md"]).toBe("LEAN AGENTS");
    expect(byName["SOUL.md"]).toBe("FULL SOUL");
    expect(byName["BOOTSTRAP.md"]).toBe("boot");
  });

  it("no variants present → only boilerplate exclusion applies", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appboot2-"));
    const files: BootFiles = [
      { name: "AGENTS.md", path: path.join(dir, "AGENTS.md"), content: "A", missing: false },
      { name: "TOOLS.md", path: path.join(dir, "TOOLS.md"), content: "t", missing: false },
    ];
    const out = await applyAppBootstrapVariants(files, dir);
    expect(out.map((f) => f.name)).toEqual(["AGENTS.md"]);
    expect(out[0]?.content).toBe("A");
  });
});
