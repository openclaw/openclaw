import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withResolvedTemplateAddSource } from "./gateway-add-source.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("snapshots and retains only canonical local project content without claiming registry trust", async () => {
  const project = dirs.make("local-project-");
  const stateDir = dirs.make("local-state-");
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "@fixture/local-template",
      version: "1.0.0",
      openclaw: { template: "CLAW.md" },
    }),
  );
  const manifest =
    "---\nschemaVersion: 1\nagent: { id: local-template }\n---\nLocal instructions.\n";
  await writeFile(join(project, "CLAW.md"), manifest);
  await writeFile(join(project, "private.txt"), "not selected");
  const result = await withResolvedTemplateAddSource({
    coordinate: { kind: "local", path: project },
    mode: "apply",
    stateDir,
    run: async (source, trust, persist) => {
      expect(trust).toMatchObject({
        riskAcknowledgementRequired: false,
        trustWarning: expect.stringContaining("not published to or scanned"),
      });
      expect(trust).not.toHaveProperty("trustRecord");
      await writeFile(join(project, "CLAW.md"), manifest + "Changed after build.");
      const retained = await persist();
      expect(retained.source.integrity).toBe(source.source.integrity);
      expect(await readFile(join(retained.source.packageRoot, "CLAW.md"), "utf8")).toBe(manifest);
      await expect(
        readFile(join(retained.source.packageRoot, "private.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      return retained.source.integrity;
    },
  });
  expect(result.value).toMatch(/^sha256:[a-f0-9]{64}$/);
});

it("rejects relative Gateway-host paths before source access", async () => {
  await expect(
    withResolvedTemplateAddSource({
      coordinate: { kind: "local", path: "relative" },
      mode: "preview",
      run: async () => undefined,
    }),
  ).rejects.toThrow("absolute paths");
});
