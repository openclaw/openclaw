import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../../process/exec.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";

describe("package runtime compatibility guidance", () => {
  afterEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "admits only a compatible explicit replacement (fallback=%s)",
    async (fallback) => {
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => ({
        stdout: argv[0] === "/old/node" ? "v22.23.1" : "v26.8.1",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      }));
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2027.1.0", nodeEngine: ">=24.16.0 <25 || >=26.1.0" },
        nodeRunner: "/old/node",
        fallbackNodeRunner: fallback ? "/new/node" : undefined,
      });
      if (fallback) {
        expect(result).toEqual({
          ok: true,
          value: {
            nodeRunner: "/new/node",
            replacedNodeRunner: "/old/node",
            targetVersion: "2027.1.0",
          },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("Node 22.23.1 at /old/node is incompatible"),
        });
      }
    },
  );

  it("checks installed package engines when registry target metadata is absent", async () => {
    await withTempDir("openclaw-runtime-target-", async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ version: "2027.1.0", engines: { node: ">=90.0.0" } }),
      );
      expect(await resolvePackageRuntimePreflight({ installedRoot: root })).toMatchObject({
        ok: false,
        error: expect.stringContaining("The requested package requires >=90.0.0."),
      });
    });
  });
  it.each(["22.23.2", "24.15.0", "25.9.0", "26.0.0"])(
    "renders the target engine range for unsupported Node %s",
    async (node) => {
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
      const engine = ">=24.16.0 <25 || >=26.1.0";
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.3", nodeEngine: engine },
      });
      expect(result).toEqual({
        ok: false,
        error: [
          `Node ${node} is incompatible with openclaw@2026.9.3.`,
          `The requested package requires ${engine}.`,
          "Use a Node runtime that satisfies the engine range above, then rerun `openclaw update`.",
          "Bare `npm i -g openclaw` can silently install an older compatible release.",
          "After switching Node versions, use `npm i -g openclaw@latest`.",
        ].join("\n"),
      });
    },
  );

  for (const { name, engine } of [
    {
      name: "reports the full target range when Node is below its minimum",
      engine: ">=90.2.0 <91 || >=92.5.0",
    },
    {
      name: "reports incompatibility when Node exceeds an exclusive upper bound",
      engine: ">=22.22.3 <23",
    },
  ]) {
    it(name, async () => {
      const version = "2027.1.0";
      const result = await resolvePackageRuntimePreflight({
        target: { version, nodeEngine: engine },
      });
      if (result.ok) {
        throw new Error("Expected an incompatible Node runtime to be refused");
      }
      expect(result.error.split("\n")).toHaveLength(5);
      expect(result.error).toContain(`The requested package requires ${engine}.`);
      const runtime = `Node ${process.versions.node}`;
      expect(result.error, "Node compatibility guidance must describe the target range").toBe(
        [
          `${runtime} is incompatible with openclaw@${version}.`,
          `The requested package requires ${engine}.`,
          "Use a Node runtime that satisfies the engine range above, then rerun `openclaw update`.",
          "Bare `npm i -g openclaw` can silently install an older compatible release.",
          "After switching Node versions, use `npm i -g openclaw@latest`.",
        ].join("\n"),
      );
    });
  }

  it("preserves a compatible target", async () => {
    await expect(
      resolvePackageRuntimePreflight({ target: { version: "2027.1.0", nodeEngine: ">=20.0.0" } }),
    ).resolves.toEqual({ ok: true, value: { targetVersion: "2027.1.0" } });
  });

  it("preserves an absent target", async () => {
    await expect(resolvePackageRuntimePreflight({})).resolves.toEqual({ ok: true, value: {} });
  });
});
