import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrivateQaCliModule } from "./private-qa-cli.js";

const mocks = vi.hoisted(() => ({ resolvePackageRoot: vi.fn<() => string>() }));
vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: mocks.resolvePackageRoot,
}));

describe("private-qa-cli", () => {
  let root: string;

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
    "loads the private QA artifact from a source checkout marked by %s",
    async (marker) => {
      fs.writeFileSync(path.join(root, marker), "");
      fs.mkdirSync(path.join(root, "src"));
      const artifactDirectory = path.join(root, "dist", "plugin-sdk");
      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDirectory, "qa-lab.js"),
        'export const isQaLabCliAvailable = () => true; export const registerQaLabCli = () => "registered";',
      );

      const module = await loadPrivateQaCliModule();
      expect(module.isQaLabCliAvailable).toBeTypeOf("function");
      expect(module.registerQaLabCli).toBeTypeOf("function");
    },
  );

  it("rejects non-source package roots even when private QA is enabled", () => {
    expect(() => loadPrivateQaCliModule()).toThrow(
      "Private QA CLI is only available from an OpenClaw source checkout.",
    );
  });

  it("rejects when the private QA env flag is disabled", () => {
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", undefined);
    expect(() => loadPrivateQaCliModule()).toThrow(
      "Private QA CLI is only available from an OpenClaw source checkout.",
    );
  });
});
