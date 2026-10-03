import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { installFromValidatedNpmSpecArchive } from "./install-from-npm-spec.js";
import { packNpmSpecToArchive } from "./install-source-utils.js";

vi.mock("./install-source-utils.js", () => ({
  packNpmSpecToArchive: vi.fn(),
  withInstallWorkspace: vi.fn(() => {
    throw new Error("Borrowed workspace must stay with its owner");
  }),
}));
afterEach(() => vi.mocked(packNpmSpecToArchive).mockReset());

it("keeps a borrowed acquisition workspace on uncertain pack failure without calling installation", async () => {
  await withTestDir({ prefix: "borrowed-acquisition-" }, async (workspaceDir) => {
    vi.mocked(packNpmSpecToArchive).mockImplementation(async ({ cwd }) => {
      await fs.writeFile(path.join(cwd, "partial.tgz"), "owned-by-pack");
      throw new CommandProcessCleanupError();
    });
    const install = vi.fn(async () => ({ ok: true as const }));
    const error = await installFromValidatedNpmSpecArchive({
      spec: "@openai/codex@99.1.0",
      workspaceDir,
      tempDirPrefix: "unused",
      timeoutMs: 1000,
      expectedIntegrity: "sha512-synthetic",
      archiveInstallParams: {},
      installFromArchive: install,
    }).catch((caught: unknown) => caught);
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    expect(install).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(workspaceDir, "partial.tgz"), "utf8")).toBe("owned-by-pack");
  });
});
