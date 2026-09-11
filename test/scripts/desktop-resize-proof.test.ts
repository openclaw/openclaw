import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopProofAssets,
  desktopProofSource,
  desktopResizeStages,
  exportDesktopResizeProof,
  sanitizeDesktopResizeProof,
  withDesktopProofCleanup,
} from "../../scripts/lib/desktop-resize-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "d".repeat(40);
const size = { width: 1200, height: 850 };
const assets = { "index-fixture.js": "e".repeat(64) };
const proof = (carrier: "node" | "ssh" = "node") => ({
  carrier,
  observerFilterPhase: carrier === "node" ? "clientInit" : "version",
  node:
    carrier === "node"
      ? {
          deviceId: "private-node-id",
          passwordAbsentFromObserve: true,
          disconnectClosedViewer: true,
        }
      : null,
  observer: { keyboardForwardedBytes: 0, resizeForwardedBytes: 0 },
  assets,
  samples: desktopResizeStages.map((stage) => ({ stage, ...size })),
  pixels: { distinctSampledColors: 100 },
  provenance: { privatePath: "/private/fixture" },
  hello: { token: "private-token" },
});

describe("desktop proof identity and public evidence", () => {
  it("launches only the owned foreground window manager, without session autostart", async () => {
    const bootstrap = await readFile(
      new URL("../../scripts/test-desktop-resize-real.mts", import.meta.url),
      "utf8",
    );
    expect(bootstrap).toContain('daemon(`wm-${display}`, "openbox", ["--sm-disable"], env)');
    expect(bootstrap).not.toMatch(
      /"(?:startxfce4|xfce4-session|openbox-session|dbus-run-session|--startup)"/u,
    );
  });

  it("retains child ownership when both private logging and export fail", async () => {
    const child = Object.assign(new Error("child cleanup failed"), {
      processTreeState: "live",
      code: "EPROCESSGROUP_CLEANUP_FAILED",
    });
    const logging = new Error("log write failed");
    const exporting = new Error("export failed");
    let unjoined = false;
    const record = (error: unknown) => {
      unjoined ||= hasUnjoinedWork(error);
    };
    const failure = await withDesktopProofCleanup(
      () =>
        withDesktopProofCleanup(
          async () => {
            throw child;
          },
          async () => {
            expect(unjoined).toBe(true);
            throw logging;
          },
          record,
        ),
      async () => {
        expect(unjoined).toBe(true);
        throw exporting;
      },
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0].errors).toEqual([child, logging]);
    expect(aggregate.errors[1]).toBe(exporting);
    expect(hasUnjoinedWork(failure)).toBe(true);
    expect(unjoined).toBe(true);
  });

  it.each(["entries", "bytes"] as const)(
    "shares the %s budget across node and SSH",
    async (limit) => {
      const root = dirs.make("desktop-shared-budget-");
      const input = path.join(root, "input");
      await mkdir(input);
      const data = JSON.stringify(assets);
      await writeFile(path.join(input, "served-assets.json"), data);
      const budget = {
        entries: limit === "entries" ? 255 : 0,
        bytes: limit === "bytes" ? 64 * 1024 ** 2 - Buffer.byteLength(data) : 0,
      };
      await exportDesktopResizeProof(input, path.join(root, "node"), "node", budget);
      await expect(
        exportDesktopResizeProof(input, path.join(root, "ssh"), "ssh", budget),
      ).rejects.toThrow(/bound/u);
    },
  );
  it("distinguishes literal head proof from GitHub merge-tree proof", () => {
    expect(
      desktopProofSource({ head, tree, parents: [base] }, { checkout: head, head, base }).kind,
    ).toBe("pr-head");
    expect(
      desktopProofSource(
        { head: merge, tree, parents: [base, head] },
        { checkout: merge, head, base },
      ),
    ).toMatchObject({ kind: "pr-merge", prHead: head, prBase: base, head: merge });
    expect(desktopProofSource({ head, tree, parents: [base] }, { checkout: head }).kind).toBe(
      "checkout",
    );
  });

  it.each([
    { checkout: base, head, base },
    { checkout: merge, head: base, base: head },
    { checkout: merge, head },
  ])("rejects source drift and unbound PR parents: %j", (expected) => {
    expect(() =>
      desktopProofSource({ head: merge, tree, parents: [base, head] }, expected),
    ).toThrow();
  });

  it.each(["node", "ssh"] as const)("exports only named %s facts", (carrier) => {
    const safe = sanitizeDesktopResizeProof(proof(carrier), carrier);
    expect(JSON.stringify(safe)).not.toMatch(/private|hello|token|deviceId/u);
    expect(safe.carrier).toBe(carrier);
    expect(safe.samples).toHaveLength(5);
  });

  it.each([
    { node: null },
    { node: { passwordAbsentFromObserve: true, disconnectClosedViewer: false } },
    { observer: { keyboardForwardedBytes: 1, resizeForwardedBytes: 0 } },
    { observerFilterPhase: "version" },
    { samples: [] },
    { pixels: { distinctSampledColors: 8 } },
  ])("rejects incomplete or failed node proof: %j", (invalid) => {
    expect(() => sanitizeDesktopResizeProof({ ...proof(), ...invalid }, "node")).toThrow();
  });

  it("rejects asset paths and non-digests", () => {
    expect(() => desktopProofAssets({ "../index.js": "e".repeat(64) })).toThrow();
    expect(() => desktopProofAssets({ "index.js": "private" })).toThrow();
  });

  it("exports a complete bounded allowlist without raw diagnostics or metadata", async () => {
    const root = dirs.make("desktop-public-proof-");
    const input = path.join(root, "input");
    const output = path.join(root, "public");
    const nested = path.join(input, "desktop-suite");
    await mkdir(nested, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(nested, "01-fit.png"), png);
    for (const stage of desktopResizeStages) {
      await writeFile(path.join(nested, `${stage}.png`), png);
      await writeFile(
        path.join(nested, `${stage}-geometry.json`),
        JSON.stringify({
          stage,
          expected: size,
          guest: size,
          canvas: size,
          matchOffered: true,
          hello: { token: "private" },
        }),
      );
    }
    await writeFile(path.join(nested, "served-assets.json"), JSON.stringify(assets));
    await writeFile(path.join(nested, "resize-proof.json"), JSON.stringify(proof()));
    await writeFile(path.join(nested, "connection-diagnostics.json"), "private-token");
    expect((await exportDesktopResizeProof(input, output, "node")).complete).toBe(true);
    expect(await readdir(output)).toHaveLength(13);
    expect(await readFile(path.join(output, "resize-proof.json"), "utf8")).not.toMatch(
      /private|hello|deviceId/u,
    );
    expect(await readFile(path.join(output, "02-panel-geometry.json"), "utf8")).not.toContain(
      "hello",
    );
  });

  it("does not turn a skipped test into completed proof", async () => {
    const root = dirs.make("desktop-empty-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    expect((await exportDesktopResizeProof(input, path.join(root, "public"), "ssh")).complete).toBe(
      false,
    );
  });

  it("rejects symlinks instead of publishing their targets", async () => {
    const root = dirs.make("desktop-symlink-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    await writeFile(path.join(root, "secret"), "private-token");
    await symlink(path.join(root, "secret"), path.join(input, "resize-proof.json"));
    await expect(
      exportDesktopResizeProof(input, path.join(root, "public"), "node"),
    ).rejects.toThrow("regular-file");
  });
});
