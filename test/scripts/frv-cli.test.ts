import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("frv CLI", () => {
  it.each(["--help", "-h", "help"])("prints help successfully for %s", (argument) => {
    const result = spawnSync(process.execPath, [resolve("scripts/frv.mjs"), argument], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: pnpm frv");
    expect(result.stdout).toContain("--no-follow");
  });

  it.each([
    ["--run", "77", "--workflow-sha", "a".repeat(40), "--request-file", "unused-request.json"],
    ["--reconcile-request", "unused-request.json"],
  ])("rejects retired receipt recovery before transport for %j", (...arguments_) => {
    const preload = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const rejectTransport = () => {
        process.stdout.write("unexpected transport");
        throw new Error("unexpected transport");
      };
      childProcess.spawn = rejectTransport;
      childProcess.execFileSync = rejectTransport;
      childProcess.execFile = rejectTransport;
      globalThis.fetch = rejectTransport;
      syncBuiltinESMExports();
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        resolve("scripts/frv.mjs"),
        "recover",
        ...arguments_,
      ],
      { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[frv] recover is retired");
    expect(result.stderr).toContain("fresh qualification with pnpm ci:full-release");
    expect(result.stdout).toBe("");
  });

  it.each([
    ["status", "--no-follow is valid only with rerun --job"],
    ["rerun", "--no-follow is valid only with rerun --job", "--child", "normalCi"],
  ])("rejects --no-follow for unsupported %s commands", (command, message, ...arguments_) => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/frv.mjs"), command, "--run", "77", ...arguments_, "--no-follow"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[frv] ${message}`);
  });
});
