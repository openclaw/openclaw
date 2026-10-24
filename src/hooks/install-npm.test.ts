import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { packNpmSpecToArchive, withInstallWorkspace } from "../infra/install-source-utils.js";
import { installHooksFromNpmSpec, type InstallHooksResult } from "./install.js";

const { extract } = vi.hoisted(() => ({
  extract: vi.fn<(params: { archivePath: string }) => Promise<InstallHooksResult>>(),
}));

vi.mock("../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/install-source-utils.js")>()),
  withInstallWorkspace: vi.fn(async (_prefix: string, run: (dir: string) => Promise<unknown>) =>
    run("/tmp/openclaw-npm-pack-install-test"),
  ),
  packNpmSpecToArchive: vi.fn(),
  resolveArchiveSourcePath: async (archivePath: string) => ({ ok: true, path: archivePath }),
}));
vi.mock("../infra/install-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/install-flow.js")>()),
  withExtractedArchiveRoot: (params: { archivePath: string }) => extract(params),
}));

const baseSpec = "@openclaw/test@1.0.0";
const baseArchivePath = "/tmp/openclaw-test.tgz";
const installed = {
  ok: true as const,
  hookPackId: "audit-hooks",
  hooks: ["audit"],
  targetDir: "/tmp/hooks/audit-hooks",
};
const install = (options: Partial<Parameters<typeof installHooksFromNpmSpec>[0]> = {}) =>
  installHooksFromNpmSpec({ spec: baseSpec, timeoutMs: 1000, ...options });
function packed(metadata: { resolvedSpec?: string; integrity?: string; version?: string } = {}) {
  vi.mocked(packNpmSpecToArchive).mockResolvedValue({
    ok: true,
    archivePath: baseArchivePath,
    metadata: { resolvedSpec: baseSpec, integrity: "sha512-same", ...metadata },
  });
}
beforeEach(() => {
  vi.mocked(packNpmSpecToArchive).mockReset();
  vi.mocked(withInstallWorkspace).mockClear();
  extract.mockReset().mockResolvedValue(installed);
});

describe("npm hook admission", () => {
  it("returns packing failure without extracting", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({ ok: false, error: "pack failed" });
    await expect(install()).resolves.toEqual({ ok: false, error: "pack failed" });
    expect(extract).not.toHaveBeenCalled();
    expect(withInstallWorkspace).toHaveBeenCalledWith("openclaw-hook-pack-", expect.any(Function));
  });

  it("rejects non-registry specs before packing or creating a workspace", async () => {
    await expect(install({ spec: "file:/tmp/openclaw.tgz" })).resolves.toEqual({
      ok: false,
      error: "unsupported npm spec: protocol specs are not allowed",
    });
    expect(packNpmSpecToArchive).not.toHaveBeenCalled();
    expect(withInstallWorkspace).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("retains hook identity and resolution metadata after matching integrity", async () => {
    packed({ version: "1.0.0" });
    const result = await install({ spec: `  ${baseSpec}  `, expectedIntegrity: "sha512-same" });
    expect(result).toMatchObject({
      ...installed,
      npmResolution: { resolvedSpec: baseSpec, integrity: "sha512-same", version: "1.0.0" },
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(Date.parse(result.npmResolution?.resolvedAt ?? "")).not.toBeNaN();
    expect(packNpmSpecToArchive).toHaveBeenCalledWith(expect.objectContaining({ spec: baseSpec }));
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ archivePath: baseArchivePath }));
  });

  it("extracts only after an integrity-drift callback accepts the resolved archive", async () => {
    packed({ integrity: "sha512-new" });
    const onIntegrityDrift = vi.fn(async () => {
      expect(extract).not.toHaveBeenCalled();
      return true;
    });
    await expect(
      install({ expectedIntegrity: "sha512-old", onIntegrityDrift }),
    ).resolves.toMatchObject(installed);
    expect(onIntegrityDrift).toHaveBeenCalledExactlyOnceWith({
      spec: baseSpec,
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
      resolution: {
        resolvedSpec: baseSpec,
        integrity: "sha512-new",
        resolvedAt: expect.any(String),
      },
    });
    expect(extract).toHaveBeenCalledOnce();
  });

  it.each([false, undefined] as const)("rejects drift without approval (%s)", async (approval) => {
    packed({ integrity: "sha512-new" });
    const warn = vi.fn();
    await expect(
      install({
        expectedIntegrity: "sha512-old",
        onIntegrityDrift: approval === undefined ? undefined : async () => approval,
        logger: { warn },
      }),
    ).resolves.toEqual({
      ok: false,
      error: "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    });
    expect(extract).not.toHaveBeenCalled();
    if (approval === undefined) {
      expect(warn).toHaveBeenCalledWith(
        "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
      );
    }
  });

  it.each([
    { tag: "latest", allowed: false },
    { tag: "beta", allowed: true },
  ])("requires explicit prerelease selection ($tag)", async ({ tag, allowed }) => {
    const spec = `@openclaw/test@${tag}`;
    packed({ resolvedSpec: spec, version: "1.1.0-beta.1" });
    const result = await install({ spec });
    expect(result.ok).toBe(allowed);
    if (result.ok) {
      expect(result.npmResolution?.version).toBe("1.1.0-beta.1");
      expect(extract).toHaveBeenCalledOnce();
    } else {
      expect(result.error).toContain("prerelease version 1.1.0-beta.1");
      expect(result.error).toContain('Use "npm:@openclaw/test@beta"');
      expect(extract).not.toHaveBeenCalled();
    }
  });
});

describe("npm archive workspace lifetime", () => {
  it("does not expose success when workspace settlement rejects", async () => {
    packed();
    const failure = new Error("workspace cleanup failed");
    vi.mocked(withInstallWorkspace).mockImplementationOnce(async (_prefix, run) => {
      await run("/tmp/openclaw-npm-pack-install-test");
      throw failure;
    });
    await expect(install()).rejects.toBe(failure);
  });

  it.each(["success", "failure", "throw"] as const)(
    "cleans its real workspace before exposing %s",
    async (outcome) => {
      const actual = await vi.importActual<typeof import("../infra/install-source-utils.js")>(
        "../infra/install-source-utils.js",
      );
      vi.mocked(withInstallWorkspace).mockImplementationOnce((prefix, run) =>
        actual.withInstallWorkspace(prefix, run),
      );
      let workspace = "";
      vi.mocked(packNpmSpecToArchive).mockImplementationOnce(async ({ cwd }) => {
        workspace = cwd;
        const archivePath = path.join(cwd, "package.tgz");
        await fs.writeFile(archivePath, "owned archive");
        return { ok: true, archivePath, metadata: { version: "1.0.0" } };
      });
      const transactionKey = Symbol.for("openclaw.packageDirInstallTransaction");
      const transaction = { commit: vi.fn(), rollback: vi.fn() };
      const failure = {
        ok: false as const,
        error: "policy refused",
        code: "security_scan_blocked",
      };
      const thrown = new Error("installer failed");
      extract.mockImplementationOnce(async ({ archivePath }) => {
        expect(await fs.readFile(archivePath, "utf8")).toBe("owned archive");
        if (outcome === "throw") {
          throw thrown;
        }
        return outcome === "failure" ? failure : { ...installed, [transactionKey]: transaction };
      });
      const result = install();
      if (outcome === "throw") {
        await expect(result).rejects.toBe(thrown);
      } else if (outcome === "failure") {
        await expect(result).resolves.toBe(failure);
      } else {
        await expect(result).resolves.toMatchObject({
          ...installed,
          [transactionKey]: transaction,
          npmResolution: { version: "1.0.0" },
        });
      }
      expect(workspace).not.toBe("");
      expect(existsSync(workspace)).toBe(false);
    },
  );
});
