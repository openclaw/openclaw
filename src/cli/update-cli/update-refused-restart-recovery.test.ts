import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  REFUSED_RESTART_RECOVERY,
  resolveRefusedRestartRecovery,
} from "./update-refused-restart-recovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { name: "a service still on the previous package", service: "2026.11.5", recovery: true },
  { name: "a service already on this package", service: "2026.11.6", recovery: false },
  { name: "another failure", service: "2026.11.5", reason: "doctor-failed", recovery: false },
])("names the verified service recovery only for $name", async (variant) => {
  const base = tempDirs.make("openclaw-refused-restart-");
  const roots = Object.fromEntries(
    ["2026.11.5", "2026.11.6"].map((version) => {
      const root = path.join(base, version, "openclaw");
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      const manifest = JSON.stringify({ name: "openclaw", version });
      fs.writeFileSync(path.join(root, "package.json"), manifest);
      fs.writeFileSync(path.join(root, "dist", "index.js"), "");
      return [version, fs.realpathSync(root)];
    }),
  );
  const entry = path.join(roots[variant.service]!, "dist", "index.js");

  const recovery = await resolveRefusedRestartRecovery({
    run: { status: "failed", reason: variant.reason ?? "service-revalidation-failed" },
    command: { programArguments: [process.execPath, entry, "gateway", "--port", "18789"] },
    activeRoot: roots["2026.11.6"],
  });

  expect(recovery).toBe(variant.recovery ? REFUSED_RESTART_RECOVERY : undefined);
});
