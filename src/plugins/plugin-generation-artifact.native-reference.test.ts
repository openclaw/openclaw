import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

it("validates a hardlinked companion placement once per capture, including recovery", async () => {
  await withOpenClawTestState({ label: "native-reference-verdict" }, async (state) => {
    const root = state.path("plugin");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"native-reference-fixture"}');
    fs.writeFileSync(path.join(root, "index.cjs"), "exports.value = 1;");
    fs.writeFileSync(path.join(root, "helper.dat"), "original companion");
    fs.mkdirSync(path.join(root, "companion-sentinel"));
    for (let index = 0; index < 8; index++) {
      fs.writeFileSync(path.join(root, `addon-${index}.node`), `native fixture ${index}`);
    }
    const symlink = fs.symlinkSync;
    const denial = vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
      if (type === "file") {
        throw Object.assign(new Error("fixture file symlinks unavailable"), { code: "EPERM" });
      }
      symlink(target, link, type);
    });
    const paths = vi.spyOn(fs, "realpathSync");
    const walks = (directory: string) =>
      paths.mock.calls.filter(
        ([filename]) => filename === path.join(directory, "companion-sentinel"),
      ).length;
    const cache = createPluginCache();
    const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
    let recovery:
      | ReturnType<ReturnType<typeof capturePluginGenerationArtifact>["captureRecoverySource"]>
      | undefined;
    const capture = () => {
      const artifact = withPluginCache(cache, () => capturePluginGenerationArtifact(root));
      artifacts.push(artifact);
      return artifact;
    };
    try {
      const first = capture();
      expect.soft(walks(first.rootDir)).toBe(1);
      paths.mockClear();
      for (let index = 0; index < 8; index++) {
        first.prepareDependency(first.resolve(path.join(root, "index.cjs")), "node:fs");
      }
      expect.soft(walks(first.rootDir)).toBe(0);

      const hosts = [state.path("host-first"), state.path("host-second")];
      for (const host of hosts) {
        fs.mkdirSync(host);
      }
      paths.mockClear();
      first.linkHost(hosts[0]!);
      expect.soft(walks(first.rootDir)).toBe(1);
      const successor = capture();
      expect.soft(walks(successor.rootDir)).toBe(1);
      paths.mockClear();
      successor.linkHost(hosts[1]!);
      expect.soft(walks(successor.rootDir)).toBe(1);
      paths.mockClear();
      recovery = first.captureRecoverySource();
      expect.soft(walks(recovery.rootDir)).toBe(1);
      expect(fs.readFileSync(path.join(recovery.rootDir, "helper.dat"), "utf8")).toBe(
        "original companion",
      );

      fs.writeFileSync(path.join(root, "helper.dat"), "replacement companion");
      const replacement = capture();
      expect(replacement.sourceDigest).not.toBe(first.sourceDigest);
      expect(fs.statSync(replacement.resolve(path.join(root, "addon-0.node"))).ino).not.toBe(
        fs.statSync(first.resolve(path.join(root, "addon-0.node"))).ino,
      );
      expect.soft(walks(replacement.rootDir)).toBe(1);
      expect(fs.readFileSync(path.join(replacement.rootDir, "helper.dat"), "utf8")).toBe(
        "replacement companion",
      );
      expect(fs.readFileSync(path.join(first.rootDir, "helper.dat"), "utf8")).toBe(
        "original companion",
      );
      fs.writeFileSync(path.join(replacement.rootDir, "helper.dat"), "damaged capture");
      expect(() => replacement.linkHost(hosts[0]!)).toThrow(
        "Native plugin companions cannot be preserved",
      );
    } finally {
      paths.mockRestore();
      denial.mockRestore();
      await recovery?.disposeAsync();
      for (const artifact of artifacts) {
        await artifact.disposeAsync();
      }
      await retirePluginCache(cache);
    }
  });
});
