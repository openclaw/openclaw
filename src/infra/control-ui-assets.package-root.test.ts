import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveControlUiRootSync } from "./control-ui-assets.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["package", "symlinked wrapper"] as const)(
  "finds healthy assets through the canonical root of a %s launcher",
  async (launcher) => {
    const fixture = tempDirs.make("openclaw-control-ui-package-root-");
    const root = path.join(fixture, "lib", "node_modules", "openclaw");
    const entrypoint = path.join(root, "openclaw.mjs");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    fs.writeFileSync(entrypoint, "");
    fs.writeFileSync(indexPath, "<html></html>");
    let argv1 = entrypoint;
    if (launcher === "symlinked wrapper") {
      argv1 = path.join(fixture, "bin", "openclaw");
      fs.mkdirSync(path.dirname(argv1), { recursive: true });
      fs.symlinkSync(entrypoint, argv1, "file");
    }

    expect(resolveControlUiRootSync({ argv1 })).toBe(path.dirname(indexPath));
  },
);
