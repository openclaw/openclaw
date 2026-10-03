import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installImmutableLauncher } from "./update-immutable-generation.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "linux" && process.getuid?.() === 0)(
  "execs one physical generation and keeps lazy imports pinned after current changes, refusing an escaping pointer",
  async () => {
    const fixture = temporary.make("openclaw-immutable-launcher-");
    const root = path.join(fixture, "installation");
    fs.mkdirSync(root, { mode: 0o755 });
    const runtime = path.join(fixture, "node");
    fs.copyFileSync(process.execPath, runtime);
    fs.chownSync(runtime, 0, 0);
    fs.chmodSync(runtime, 0o755);
    const previous = path.join(root, "releases", "a".repeat(40));
    const next = path.join(root, "releases", "b".repeat(40));
    for (const { generation, value } of [
      { generation: previous, value: "previous" },
      { generation: next, value: "next" },
    ]) {
      fs.mkdirSync(path.join(generation, "dist"), { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(generation, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(generation, "dist", "lazy.js"),
        `export default ${JSON.stringify(value)};`,
      );
    }
    fs.symlinkSync(previous, path.join(root, "current"));
    const payload = `
import fs from "node:fs";
fs.symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(path.join(root, "replacement"))});
fs.renameSync(${JSON.stringify(path.join(root, "replacement"))}, ${JSON.stringify(path.join(root, "current"))});
console.log(JSON.stringify({cwd: process.cwd(), entry: process.argv[1], args: process.argv.slice(2), lazy: (await import("./lazy.js")).default}));
`;
    fs.writeFileSync(path.join(previous, "dist", "index.js"), payload, { mode: 0o444 });
    const launcher = await installImmutableLauncher({ root, runtimePath: runtime });
    expect(await installImmutableLauncher({ root, runtimePath: runtime })).toBe(launcher);
    const launched = spawnSync(launcher, ["--port", "19547"], { encoding: "utf8" });
    expect(launched.stderr).not.toContain("Cannot start");
    expect(launched.status).toBe(0);
    expect(JSON.parse(launched.stdout)).toEqual({
      cwd: previous,
      entry: path.join(previous, "dist", "index.js"),
      args: ["gateway", "--port", "19547"],
      lazy: "previous",
    });
    expect(fs.realpathSync(path.join(root, "current"))).toBe(next);

    fs.unlinkSync(path.join(root, "current"));
    fs.symlinkSync(path.dirname(root), path.join(root, "current"));
    const refused = spawnSync(launcher, [], { encoding: "utf8" });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain("direct releases/<full-sha>");

    fs.writeFileSync(launcher, "foreign launcher\n");
    await expect(installImmutableLauncher({ root, runtimePath: runtime })).rejects.toThrow(
      "conflicts",
    );
    expect(fs.readFileSync(launcher, "utf8")).toBe("foreign launcher\n");
  },
);
