import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runOxlint } from "../../scripts/run-oxlint.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(async () => 0),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { mode: "core", flags: [], prepared: true, partial: false },
  { mode: "partial core", flags: [], prepared: true, partial: true },
  { mode: "focused syntax", flags: ["--openclaw-focused-config"], prepared: false, partial: false },
  { mode: "metadata", flags: ["--help"], prepared: false, partial: false },
])("prepares schema declarations before $mode lint", async ({ flags, prepared, partial }) => {
  const checkout = process.cwd();
  const root = tempDirs.make("oxlint-kysely-");
  fs.mkdirSync(path.join(root, "src/state"), { recursive: true });
  fs.mkdirSync(path.join(root, "config/tsconfig"), { recursive: true });
  fs.writeFileSync(path.join(root, "config/tsconfig/oxlint.core.json"), "{}");
  fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
  fs.symlinkSync(path.join(checkout, "node_modules"), path.join(root, "node_modules"), "junction");
  const schemas = partial ? ["openclaw-state"] : ["openclaw-state", "openclaw-agent"];
  for (const name of schemas) {
    fs.writeFileSync(
      path.join(root, "src/state", `${name}-schema.sql`),
      "CREATE TABLE records (id TEXT NOT NULL);",
    );
  }
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.mocked(runManagedCommand).mockImplementationOnce(async () => {
    for (const name of schemas) {
      const output = path.join(root, ".artifacts/kysely", `${name}-db.generated.ts`);
      expect(fs.existsSync(output)).toBe(prepared);
      if (prepared) {
        expect(fs.readFileSync(output, "utf8")).toContain("  id: string;");
      }
    }
    return 0;
  });
  expect(
    await runOxlint(["--tsconfig", "config/tsconfig/oxlint.core.json", "source.ts", ...flags], {
      ...process.env,
      OPENCLAW_LOCAL_CHECK: "0",
      OPENCLAW_CI_STATIC_EVIDENCE: "0",
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    }),
  ).toMatchObject({ status: 0 });
  expect(runManagedCommand).toHaveBeenCalledOnce();
});
