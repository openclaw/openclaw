import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { updateRecipePlanCommand } from "./plan.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

it("emits a complete non-authorizing report without modifying the inspected installation", async () => {
  const root = dirs.make("openclaw-plan-command-");
  const manifest = '{"name":"openclaw","version":"2026.9.1"}';
  await fs.writeFile(path.join(root, "package.json"), manifest);
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  await updateRecipePlanCommand({ installation: root, json: true });
  expect(output).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      schemaVersion: 1,
      kind: "report-only",
      mutationEnabled: false,
      outcome: "blocked",
      inventory: expect.objectContaining({
        root,
        observedVersion: "2026.9.1",
        identityClass: "unknown",
      }),
      blockers: expect.arrayContaining([expect.objectContaining({ code: "catalog-unavailable" })]),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  );
  expect(process.exitCode).toBe(1);
  expect(await fs.readdir(root)).toEqual(["package.json"]);
  expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(manifest);
});

it.each(["missing", "malformed"])(
  "reports %s local catalog input as blocked JSON",
  async (failure) => {
    const root = dirs.make("openclaw-plan-catalog-");
    const catalog = path.join(root, "catalog.json");
    if (failure === "malformed") {
      await fs.writeFile(catalog, "{");
    }
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await updateRecipePlanCommand({ installation: root, catalog, json: true });
    expect(output).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "report-only",
        mutationEnabled: false,
        outcome: "blocked",
        blockers: [expect.objectContaining({ code: "catalog-unreadable" })],
      }),
    );
    expect(process.exitCode).toBe(1);
  },
);
