import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packToArchive } from "../plugins/test-helpers/archive-fixtures.js";
import {
  executePluginArtifactActivation as activateArtifact,
  prepareSystemAgentPluginArtifact as prepareArtifact,
} from "./plugin-artifact.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  audit: vi.fn(),
  parsed: {} as Record<string, unknown>,
}));
const pluginId = "artifact-demo";

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => {},
  readConfigFileSnapshot: async () => ({
    exists: true,
    valid: true,
    config: {},
    parsed: mocks.parsed,
    raw: `${JSON.stringify(mocks.parsed)}\n`,
    hash: "config",
  }),
}));
vi.mock("./inference-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inference-route.js")>()),
  projectInferenceRoute: vi.fn(async () => ({ route: null })),
}));
vi.mock("./audit.js", () => ({ appendSystemAgentAuditEntry: mocks.audit }));
vi.mock("../plugins/install-config.js", () => ({
  loadConfigForInstall: async () => ({ config: {}, baseHash: "config", writeOptions: {} }),
}));
vi.mock("../plugins/management-install.js", () => ({ installManagedPluginSource: mocks.install }));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _params: unknown,
    run: (lease: { assertOwned: () => void }) => Promise<unknown>,
  ) => await run({ assertOwned: () => {} }),
}));

describe("exact system-agent plugin artifacts", () => {
  let fixture: string;
  let runtime: ReturnType<typeof createSystemAgentTestRuntime>["runtime"];
  let lines: string[];
  const activate = (
    operation: Parameters<typeof activateArtifact>[0],
    options: Partial<Parameters<typeof activateArtifact>[2]> = {},
  ) => activateArtifact(operation, runtime, { approved: true, ...options });
  const importPath = (...parts: string[]) =>
    path.join(fixture, "state", "imports", "plugins", ...parts);
  function installedArchive() {
    const call = mocks.install.mock.calls[0];
    assert.ok(call, "The managed installer must receive the approved archive.");
    return call[0].request.recordPath;
  }
  const writeJson = (dir: string, name: string, value: unknown) =>
    fs.writeFile(path.join(dir, name), JSON.stringify(value));

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifact-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture, "state"));
    mocks.install.mockReset();
    mocks.audit.mockReset();
    mocks.parsed = {};
    ({ runtime, lines } = createSystemAgentTestRuntime());
    mocks.install.mockResolvedValue({ ok: true, pluginId, config: {} });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  async function pack(packageFields: Record<string, unknown> = {}) {
    const pkgDir = path.join(fixture, "package");
    await fs.mkdir(path.join(pkgDir, "dist", "control-ui"), { recursive: true });
    await writeJson(pkgDir, "package.json", {
      name: pluginId,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./dist/index.js"] },
      ...packageFields,
    });
    await writeJson(pkgDir, "openclaw.plugin.json", {
      id: pluginId,
      configSchema: { type: "object", properties: {} },
      controlUi: { entry: "dist/control-ui/index.js" },
    });
    for (const entry of ["index.js", "control-ui/index.js"]) {
      await fs.writeFile(path.join(pkgDir, "dist", entry), "export default {};\n");
    }
    const archivePath = await packToArchive({ pkgDir, outDir: fixture, outName: "artifact.tgz" });
    const bytes = await fs.readFile(archivePath);
    return {
      kind: "plugin-activate-artifact" as const,
      path: archivePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async function prepare() {
    const operation = await pack();
    return { operation, review: await prepareArtifact(operation) };
  }

  it("retains reviewed bytes and installs them after the task source changes", async () => {
    const { operation, review } = await prepare();
    const reviewedBytes = await fs.readFile(operation.path);
    expect(review).toMatchObject({
      pluginId,
      nativeControlUi: true,
      sha256: operation.sha256,
    });
    expect(await fs.readFile(review.retainedPath)).toEqual(reviewedBytes);
    await fs.writeFile(operation.path, "source changed after proposal");
    const beforePersistentApply = vi.fn(() => {});
    const applyPluginRuntime = vi.fn(async () => ({
      operationId: "artifact-activation",
      generation: 2,
      pluginIds: [pluginId],
    }));
    const installedPath = importPath(`${operation.sha256}.tgz`);
    mocks.install.mockImplementation(async (params) => {
      expect(params.request.path).not.toBe(review.retainedPath);
      expect(params.request.recordPath).toBe(installedPath);
      expect(await fs.readFile(params.request.path)).toEqual(reviewedBytes);
      expect(await fs.readFile(installedPath)).toEqual(reviewedBytes);
      expect(params.acknowledgeCapabilities).toEqual({ reviewToken: review.reviewToken });
      await params.beforePersistentEffect();
      params.beforePersistentApply();
      await params.applyRuntime({ config: {}, pluginIds: [pluginId], reason: "install" });
      return { ok: true, pluginId, config: {} };
    });
    expect(
      await activate(operation, { beforePersistentApply, deps: { applyPluginRuntime } }),
    ).toMatchObject({ applied: true });
    await expect(fs.access(review.retainedPath)).rejects.toThrow();
    expect(beforePersistentApply).toHaveBeenCalledTimes(3);
    expect(applyPluginRuntime).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain(
      "Artifact installed. Inspect the plugin's runtime and Control UI activation status.",
    );
    expect(mocks.audit.mock.calls.at(-1)?.[0]).toMatchObject({
      details: { pluginId, sha256: operation.sha256, sourcePath: installedPath },
    });
  });

  it("preserves the approved source when the installer reports a late failure", async () => {
    const { operation, review } = await prepare();
    const reviewedBytes = await fs.readFile(operation.path);
    const failure = new Error("registry refresh failed after commit");
    mocks.install.mockRejectedValue(failure);

    await expect(activate(operation)).rejects.toBe(failure);
    const installedPath = installedArchive();
    expect(await fs.readFile(installedPath)).toEqual(reviewedBytes);
    await expect(fs.access(review.retainedPath)).rejects.toThrow();
    expect(lines.join("\n")).toContain("propose the exact artifact again");
    expect(mocks.audit).not.toHaveBeenCalled();

    await expect(activate(operation)).rejects.toThrow(/no longer retained.*propose/i);
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it.each([
    ["changed retained archive", "SHA256 does not match"],
    ["include-owned config", "Install the reviewed archive with openclaw plugins install"],
  ])("rejects %s before entering the installer", async (failure, message) => {
    const { operation, review } = await prepare();
    if (failure === "changed retained archive") {
      await fs.writeFile(review.retainedPath, "changed reviewed bytes");
    } else {
      mocks.parsed = { plugins: { $include: "plugins.json" } };
    }
    await expect(activate(operation)).rejects.toThrow(message);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("bounds pending imports without removing an installed archive", async () => {
    const { operation } = await prepare();
    const bytes = await fs.readFile(operation.path);
    await activate(operation);
    const installedPath = installedArchive();
    const pendingDir = importPath("pending");
    await fs.mkdir(pendingDir, { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      const name = `${index.toString(16).padStart(64, "0")}.tgz`;
      await fs.writeFile(path.join(pendingDir, name), "abandoned review");
    }

    const next = await prepareArtifact(await pack({ version: "2.0.0" }));
    expect((await fs.readdir(pendingDir)).length).toBeLessThanOrEqual(8);
    expect(await fs.readFile(installedPath)).toEqual(bytes);
    expect(await fs.readFile(next.retainedPath)).not.toEqual(bytes);
  });

  it("prunes expired reviews and requires a fresh proposal before applying them", async () => {
    const { operation, review } = await prepare();
    const expired = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(review.retainedPath, expired, expired);

    await expect(activate(operation)).rejects.toThrow(/expired.*propose/i);
    expect(mocks.install).not.toHaveBeenCalled();

    await prepareArtifact(await pack({ version: "2.0.0" }));
    await expect(fs.access(review.retainedPath)).rejects.toThrow();
  });

  it.each([
    { scripts: { install: "node postinstall.js" } },
    { peerDependencies: { example: "*" } },
  ])("rejects an artifact requiring unreviewed installation inputs: %j", async (fields) => {
    const operation = await pack(fields);
    await expect(prepareArtifact(operation)).rejects.toThrow(/bundle|dependencies|scripts/);
    await expect(fs.access(importPath("pending", `${operation.sha256}.tgz`))).rejects.toThrow();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("rejects a source digest mismatch and linked source files before review", async () => {
    const operation = await pack();
    await expect(prepareArtifact({ ...operation, sha256: "0".repeat(64) })).rejects.toThrow(
      "SHA256 does not match",
    );
    const linked = path.join(fixture, "linked.tgz");
    await fs.symlink(operation.path, linked);
    await expect(prepareArtifact({ ...operation, path: linked })).rejects.toThrow();
    await fs.unlink(linked);
    await fs.link(operation.path, linked);
    await expect(prepareArtifact({ ...operation, path: linked })).rejects.toThrow();
  });
});
