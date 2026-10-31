import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSubCliEntriesCore } from "./subcli-descriptors.js";

const mocks = vi.hoisted(() => ({ resolvePackageRoot: vi.fn<() => string>() }));
vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: mocks.resolvePackageRoot,
}));

describe("private-qa-cli", () => {
  let root: string;

  async function registerPrivateQa(program: Command) {
    const qa = getSubCliEntriesCore().find((entry) => entry.name === "qa");
    if (!qa) {
      throw new Error("Expected private QA descriptor");
    }
    await qa.register(program, [], { purpose: "runtime" });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-private-qa-"));
    mocks.resolvePackageRoot.mockReturnValue(root);
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([".git", "pnpm-workspace.yaml"])(
    "registers the private QA artifact from a source checkout marked by %s",
    async (marker) => {
      fs.writeFileSync(path.join(root, marker), "");
      fs.mkdirSync(path.join(root, "src"));
      const artifactDirectory = path.join(root, "dist", "plugin-sdk");
      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDirectory, "qa-lab.js"),
        'export const registerQaLabCli = (program) => program.command("fixture-qa");',
      );

      const program = new Command();
      await registerPrivateQa(program);
      expect(program.commands.map((command) => command.name())).toEqual(["fixture-qa"]);
    },
  );

  it("rejects non-source package roots even when private QA is enabled", async () => {
    await expect(registerPrivateQa(new Command())).rejects.toThrow(
      "Private QA CLI is only available from an OpenClaw source checkout.",
    );
  });
});
