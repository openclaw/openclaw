import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeRuntimeInfo } from "../../daemon/runtime-paths.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";

const probeState = vi.hoisted(() => ({ text: true }));
vi.mock("../../daemon/runtime-paths.js", () => ({ resolveNodeRuntimeInfo: vi.fn() }));
vi.mock("../../../node-sqlite.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../node-sqlite.mjs")>();
  return {
    ...actual,
    detectCurrentSqliteCapabilities: () => ({
      available: true,
      version: "3.51.3",
      text: probeState.text,
      blob: true,
      json: true,
    }),
  };
});

describe("package runtime compatibility guidance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    probeState.text = true;
    vi.mocked(resolveNodeRuntimeInfo).mockReset();
  });

  it.each([false, true])(
    "admits only a compatible explicit replacement (fallback=%s)",
    async (fallback) => {
      vi.mocked(resolveNodeRuntimeInfo).mockImplementation(async (nodePath) => ({
        status: nodePath === "/old/node" ? "unsupported" : "supported",
        version: nodePath === "/old/node" ? "22.23.1" : "26.8.1",
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: {
          available: true,
          version: "3.51.3",
          text: nodePath !== "/old/node",
          blob: true,
          json: true,
        },
        ...(nodePath === "/old/node" ? { capabilityError: "broken TEXT decoder" } : {}),
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
      probeState.text = false;
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
      const engine = ">=24.16.0 <25 || >=26.1.0";
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.3", nodeEngine: engine },
      });
      expect(result).toEqual({
        ok: false,
        error: [
          `Node ${node} is incompatible with openclaw@2026.9.3.`,
          `Node ${node}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.16+/26.1+ or a build with the fix`,
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

  it.each([
    ["24.16.0", false, "nodejs/node#61954"],
    ["24.15.0+vendor.1", true, "The requested package requires >=24.16.0 <25 || >=26.1.0."],
    ["24.19.0", true, null],
  ] as const)(
    "requires target engines and SQLite capabilities for Node %s",
    async (node, text, error) => {
      probeState.text = text;
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
      const result = await resolvePackageRuntimePreflight({
        target: {
          version: "2026.9.3",
          nodeEngine: ">=24.16.0 <25 || >=26.1.0",
        },
      });
      expect(result.ok).toBe(error === null);
      if (!result.ok) {
        expect(result.error).toContain(error);
      }
    },
  );

  it("preserves a compatible target", async () => {
    await expect(
      resolvePackageRuntimePreflight({ target: { version: "2027.1.0", nodeEngine: ">=20.0.0" } }),
    ).resolves.toEqual({ ok: true, value: { targetVersion: "2027.1.0" } });
  });

  it("preserves an absent target", async () => {
    await expect(resolvePackageRuntimePreflight({})).resolves.toEqual({ ok: true, value: {} });
  });

  it("refuses a failed recorded-runtime probe even with an unknown target engine", async () => {
    vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
      status: "probe-failed",
      error: new Error("probe timed out"),
    });
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2026.9.3", nodeEngine: null },
      nodeRunner: "/fixture/bin/node",
      timeoutMs: 321,
    });
    expect(resolveNodeRuntimeInfo).toHaveBeenCalledWith("/fixture/bin/node", process.env, 321);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("probe timed out") });
  });

  it.each([
    ["24.15.0+vendor.1", false],
    ["24.19.0", true],
  ] as const)(
    "requires target engines for a lossless fallback Node %s",
    async (version, admitted) => {
      const sqliteProbe = {
        available: true,
        version: "3.51.3",
        text: true,
        blob: true,
        json: true,
      };
      vi.mocked(resolveNodeRuntimeInfo)
        .mockResolvedValueOnce({
          status: "unsupported",
          version: "24.16.0",
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe: { ...sqliteProbe, text: false },
          capabilityError: "broken TEXT decoder",
        })
        .mockResolvedValueOnce({
          status: "supported",
          version,
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe,
        });
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.3", nodeEngine: ">=24.16.0 <25 || >=26.1.0" },
        nodeRunner: "/fixture/old/node",
        fallbackNodeRunner: "/fixture/fixed/node",
      });
      if (admitted) {
        expect(result).toEqual({
          ok: true,
          value: {
            nodeRunner: "/fixture/fixed/node",
            replacedNodeRunner: "/fixture/old/node",
            targetVersion: "2026.9.3",
          },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining(
            "The requested package requires >=24.16.0 <25 || >=26.1.0.",
          ),
        });
      }
    },
  );
});
