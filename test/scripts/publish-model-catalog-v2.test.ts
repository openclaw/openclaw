import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  type RemoteModelCatalogBundle,
} from "@openclaw/model-catalog-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleModelCatalogBundleV2,
  parsePublishModelCatalogArgs,
  runPublishModelCatalog,
  serializeModelCatalogBundle,
  serializeModelCatalogBundleV2,
} from "../../scripts/publish-model-catalog.mts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-v2-"));
  roots.push(root);
  const dir = path.join(root, "extensions", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const seeds = Array.from({ length: 100 }, (_, index) => ({ id: `seed-${index}` }));
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: [
        "anthropic",
        "openai",
        "fixture-native",
        "gateway",
        "mygate",
        "openrouter",
        "moonshot",
      ],
      modelCatalog: {
        modelsDev: { "fixture-native": "upstream" },
        providers: {
          anthropic: {
            recommendedModels: ["missing"],
            models: seeds.map((model, index) =>
              index === 0 ? { ...model, cost: { input: 0.5 } } : model,
            ),
          },
          openai: {
            defaultModel: "seed-0",
            recommendedModels: ["seed-2", "seed-0"],
            models: seeds,
          },
          "fixture-native": {
            models: [
              { id: "free", cost: { input: 9, output: 9 } },
              { id: "paid" },
              { id: "withdrawn", cost: { input: 8, output: 8 } },
            ],
          },
        },
      },
      modelPricing: {
        providers: {
          "fixture-native": { openCode: { provider: "upstream" } },
          // Bills the vendor's rate (like Cloudflare Unified Billing): no list of its own.
          gateway: { modelsDev: { passthroughProviderModel: true }, liteLLM: false },
          // Publishes its own price list (like Vercel or Kilo).
          mygate: { modelsDev: { provider: "mygate-md", passthroughProviderModel: true } },
          openrouter: { openRouter: { provider: "openrouter" }, modelsDev: false, liteLLM: false },
          // models.dev names this vendor differently from its OpenClaw provider.
          moonshot: { modelsDev: { provider: "moonshotai" } },
        },
      },
    }),
  );
  return root;
}

function fixtureFetch() {
  return vi.fn<typeof fetch>(async (url) => {
    if (url === "https://models.opencode.ai/api.json") {
      return Response.json({
        upstream: {
          id: "upstream",
          models: {
            free: { id: "free", cost: { input: 0, output: 0 } },
            paid: { id: "paid", cost: { input: 2, output: 3 } },
            extra: { id: "extra", cost: { input: 5, output: 6 } },
          },
        },
        openai: {
          id: "openai",
          models: { "seed-1": { id: "seed-1", cost: { input: 4, output: 20 } } },
        },
        "mygate-md": {
          id: "mygate-md",
          models: { "openai/seed-1": { id: "openai/seed-1", cost: { input: 3, output: 9 } } },
        },
        moonshotai: {
          id: "moonshotai",
          models: { "kimi-k3": { id: "kimi-k3", cost: { input: 3, output: 15 } } },
        },
      });
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      // OpenRouter runs a 50% promotion on OpenAI's model.
      return Response.json({
        data: [
          { id: "vendorx/model-a", pricing: { prompt: "0.000002", completion: "0.000004" } },
          { id: "openai/seed-1", pricing: { prompt: "0.000002", completion: "0.00001" } },
        ],
      });
    }
    return Response.json({ data: [] });
  });
}

function pairFixture(existing = true) {
  const rootDir = fixtureRoot();
  const outputs: [string, string] = [
    path.join(rootDir, "v1/catalog.json"),
    path.join(rootDir, "v2/catalog.json"),
  ];
  outputs.forEach((file, index) => {
    fs.mkdirSync(path.dirname(file));
    if (existing) {
      fs.writeFileSync(file, `previous v${index + 1}`);
    }
  });
  const run = () =>
    runPublishModelCatalog({
      rootDir,
      sourceCommit: "fixture",
      now: () => 42,
      fetchImpl: fixtureFetch(),
      args: ["--out", outputs[0], "--out-v2", outputs[1]],
    });
  const recovery = (index: number) => {
    const output = outputs[index];
    if (!output) {
      throw new Error("fixture output index is invalid");
    }
    const parent = path.dirname(output);
    return fs
      .readdirSync(parent)
      .filter((name) => name.startsWith(".catalog-pair-"))
      .map((name) => path.join(parent, name));
  };
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { outputs, run, recovery, warnings };
}

describe("publish model catalog v2", () => {
  it.each([true, false])(
    "publishes through both output symlinks and keeps the links (existing=%s)",
    async (existing) => {
      const fixture = pairFixture(existing);
      const targets = fixture.outputs.map((file, index) => {
        const target = path.join(`${path.dirname(file)}-target`, "catalog.json");
        fs.mkdirSync(path.dirname(target));
        if (existing) {
          fs.renameSync(file, target);
        }
        // A symlink/.. parent must resolve on disk, not collapse lexically.
        if (index === 0) {
          fs.mkdirSync(path.join(path.dirname(target), "nested"));
          fs.symlinkSync(path.join(path.dirname(target), "nested"), `${file}.parent`, "dir");
        }
        const link = index === 0 ? "catalog.json.parent/../catalog.json" : `${file}.link`;
        if (index === 1) {
          fs.symlinkSync(target, link);
        }
        fs.symlinkSync(link, file);
        return { file, target, link };
      });
      await expect(fixture.run()).resolves.toMatchObject({ wrote: true });
      targets.forEach(({ file, target, link }, index) => {
        expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(file)).toBe(link);
        expect(JSON.parse(fs.readFileSync(target, "utf8")).schemaVersion).toBe(index + 1);
        expect(fs.readFileSync(file)).toEqual(fs.readFileSync(target));
        expect(
          fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(".catalog-pair-")),
        ).toEqual([]);
      });
    },
  );

  it.each([true, false])("rejects two links to one target (existing=%s)", async (existing) => {
    const fixture = pairFixture(false);
    const target = path.join(path.dirname(fixture.outputs[0]), "target.json");
    if (existing) {
      fs.writeFileSync(target, "original");
    }
    fixture.outputs.forEach((file) => fs.symlinkSync(target, file));
    await expect(fixture.run()).rejects.toThrow("must name different files");
    expect(fs.existsSync(target)).toBe(existing);
    if (existing) {
      expect(fs.readFileSync(target, "utf8")).toBe("original");
    }
    fixture.outputs.forEach((file, index) => {
      expect(fs.readlinkSync(file)).toBe(target);
      expect(fixture.recovery(index)).toEqual([]);
    });
  });

  it("rejects a real second-parent failure before replacing v1", async () => {
    const fixture = pairFixture();
    fs.unlinkSync(fixture.outputs[1]);
    fs.rmdirSync(path.dirname(fixture.outputs[1]));
    fs.writeFileSync(path.dirname(fixture.outputs[1]), "not a directory");
    await expect(fixture.run()).rejects.toThrow(/EEXIST|ENOTDIR/u);
    expect(fs.readFileSync(fixture.outputs[0], "utf8")).toBe("previous v1");
    expect(fixture.recovery(0)).toEqual([]);
  });

  it("keeps both existing outputs when the second prepared write fails", async () => {
    const fixture = pairFixture();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (
        typeof file === "number" &&
        typeof data === "string" &&
        data.includes('"schemaVersion": 2')
      ) {
        write(file, "partial");
        throw new Error("fixture second prepare ENOSPC");
      }
      return write(file, data, options);
    });
    await expect(fixture.run()).rejects.toThrow("fixture second prepare ENOSPC");
    fixture.outputs.forEach((file, index) => {
      expect(fs.readFileSync(file, "utf8")).toBe(`previous v${index + 1}`);
      expect(fixture.recovery(index)).toEqual([]);
    });
  });

  it.each([false, true])(
    "retains old/new recovery on a second rename failure (existing=%s)",
    async (existing) => {
      const fixture = pairFixture(existing);
      const rename = fs.promises.rename;
      vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
        if (destination === fixture.outputs[1]) {
          throw new Error("fixture second rename EIO");
        }
        return rename(source, destination);
      });
      await expect(fixture.run()).rejects.toThrow("Recovery retained:");
      expect(JSON.parse(fs.readFileSync(fixture.outputs[0], "utf8")).schemaVersion).toBe(1);
      if (existing) {
        expect(fs.readFileSync(fixture.outputs[1], "utf8")).toBe("previous v2");
      } else {
        expect(fs.existsSync(fixture.outputs[1])).toBe(false);
      }
      fixture.outputs.forEach((file, index) => {
        const dirs = fixture.recovery(index);
        expect(dirs).toHaveLength(1);
        const [dir] = dirs;
        if (!dir) {
          throw new Error("fixture recovery is missing");
        }
        expect(JSON.parse(fs.readFileSync(path.join(dir, "next.json"), "utf8")).schemaVersion).toBe(
          index + 1,
        );
        const note = fs.readFileSync(path.join(dir, "RECOVERY.txt"), "utf8");
        expect(note).toContain(file);
        expect(note).toContain(fixture.outputs[1 - index]);
        if (existing) {
          expect(fs.readFileSync(path.join(dir, "previous.json"), "utf8")).toBe(
            `previous v${index + 1}`,
          );
        } else {
          expect(note).toContain("was absent");
          expect(fs.existsSync(path.join(dir, "previous.json"))).toBe(false);
        }
      });
    },
  );

  it("retains recovery after a partial second publication write", async () => {
    const fixture = pairFixture();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (
        typeof file === "string" &&
        typeof data === "string" &&
        data.includes('"schemaVersion": 2')
      ) {
        write(file, "partial", options);
        throw new Error("fixture publication write ENOSPC");
      }
      return write(file, data, options);
    });
    await expect(fixture.run()).rejects.toThrow("fixture publication write ENOSPC");
    expect(JSON.parse(fs.readFileSync(fixture.outputs[0], "utf8")).schemaVersion).toBe(1);
    expect(fs.readFileSync(fixture.outputs[1], "utf8")).toBe("previous v2");
    expect(fixture.recovery(0)).toHaveLength(1);
    expect(fixture.recovery(1)).toHaveLength(1);
  });

  it("preserves an observed destination replacement before the second publication", async () => {
    const fixture = pairFixture();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === fixture.outputs[0]) {
        fs.unlinkSync(fixture.outputs[1]);
        fs.writeFileSync(fixture.outputs[1], "foreign replacement");
      }
    });
    await expect(fixture.run()).rejects.toThrow("output changed during preparation");
    expect(fs.readFileSync(fixture.outputs[1], "utf8")).toBe("foreign replacement");
    expect(fixture.recovery(0)).toHaveLength(1);
    expect(fixture.recovery(1)).toHaveLength(1);
  });

  it("does not roll back foreign replacements after an uncertain second rename", async () => {
    const fixture = pairFixture();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === fixture.outputs[1]) {
        for (const file of fixture.outputs) {
          fs.unlinkSync(file);
          fs.writeFileSync(file, "foreign replacement");
        }
        throw new Error("fixture post-rename failure");
      }
    });
    await expect(fixture.run()).rejects.toThrow("fixture post-rename failure");
    fixture.outputs.forEach((file, index) => {
      expect(fs.readFileSync(file, "utf8")).toBe("foreign replacement");
      expect(fixture.recovery(index)).toHaveLength(1);
    });
  });

  it("reports cleanup failure without rejecting a successfully published pair", async () => {
    const fixture = pairFixture();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).includes(".catalog-pair-")) {
        throw new Error("fixture cleanup EACCES");
      }
      unlink(file);
    });
    await expect(fixture.run()).resolves.toMatchObject({ wrote: true });
    fixture.outputs.forEach((file, index) => {
      expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(index + 1);
      expect(fixture.recovery(index)).toHaveLength(1);
    });
    expect(fixture.warnings.mock.calls.flat().join("")).toContain(
      "pair published; recovery cleanup failed",
    );
  });

  it.each([
    ["directory", "dev"],
    ["directory", "ino"],
    ["directory", "changed"],
    ["file", "dev"],
    ["file", "ino"],
    ["file", "changed"],
  ] as const)("retains a substituted recovery %s with %s identity", async (entry, identity) => {
    const fixture = pairFixture();
    const rename = fs.promises.rename;
    const lstat = fs.lstatSync;
    let replacement = "";
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination !== fixture.outputs[1]) {
        return;
      }
      const [dir] = fixture.recovery(0);
      if (!dir) {
        throw new Error("fixture recovery is missing");
      }
      const target = entry === "directory" ? dir : path.join(dir, "next.json");
      const previous = lstat(target, { bigint: true });
      fs.renameSync(target, `${target}.original`);
      if (entry === "directory") {
        fs.mkdirSync(target);
        for (const name of ["next.json", "previous.json", "RECOVERY.txt"]) {
          fs.renameSync(path.join(`${target}.original`, name), path.join(target, name));
          fs.writeFileSync(path.join(target, name), "foreign replacement");
        }
      } else {
        fs.writeFileSync(target, "foreign replacement");
      }
      replacement = entry === "directory" ? path.join(target, "next.json") : target;
      vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => {
        const current = lstat(file, options);
        if (file === target && current) {
          // Only cleanup sees Windows' unknown path-stat identity; publication uses the host.
          vi.spyOn(process, "platform", "get").mockReturnValue("win32");
          return Object.assign(current, {
            dev: identity === "dev" ? 0n : previous.dev,
            ino: identity === "ino" ? 0n : previous.ino + (identity === "changed" ? 1n : 0n),
          });
        }
        return current;
      });
    });
    await expect(fixture.run()).resolves.toMatchObject({ wrote: true });
    expect(fs.readFileSync(replacement, "utf8")).toBe("foreign replacement");
    fixture.outputs.forEach((file, index) => {
      expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(index + 1);
    });
    expect(fixture.warnings.mock.calls.flat().join("")).toContain(
      "pair published; recovery cleanup failed; retained",
    );
  });

  it.each([
    ["directory", "dev"],
    ["directory", "ino"],
    ["file", "dev"],
    ["file", "ino"],
  ] as const)("retains recovery %s when %s differs above 2^53", async (entry, field) => {
    const fixture = pairFixture();
    const lstat = fs.lstatSync;
    const fstat = fs.fstatSync;
    const open = fs.openSync;
    const close = fs.closeSync;
    const rename = fs.promises.rename;
    const descriptors = new Set<number>();
    let published = false;
    const original = 2n ** 53n;
    const replacement = original + 1n;
    expect(Number(original)).toBe(Number(replacement));
    const recoveryEntry = (file: fs.PathLike) => {
      const name = path.basename(String(file));
      return entry === "directory" ? name.startsWith(".catalog-pair-") : name === "next.json";
    };
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      descriptors.delete(fd);
      if (recoveryEntry(file)) {
        descriptors.add(fd);
      }
      return fd;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      close(fd);
      descriptors.delete(fd);
    });
    vi.spyOn(fs, "fstatSync").mockImplementation((fd, options) => {
      const stat = fstat(fd, options);
      return descriptors.has(fd)
        ? Object.assign(stat, { [field]: options?.bigint ? original : Number(original) })
        : stat;
    });
    vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => {
      const stat = lstat(file, options);
      const identity = published ? replacement : original;
      return stat && recoveryEntry(file)
        ? Object.assign(stat, { [field]: options?.bigint ? identity : Number(identity) })
        : stat;
    });
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === fixture.outputs[1]) {
        published = true;
      }
    });
    const unlink = vi.spyOn(fs, "unlinkSync");
    await expect(fixture.run()).resolves.toMatchObject({ wrote: true });
    expect(unlink).not.toHaveBeenCalled();
    fixture.outputs.forEach((file, index) => {
      expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(index + 1);
      const [dir] = fixture.recovery(index);
      if (!dir) {
        throw new Error("fixture recovery is missing");
      }
      expect(fs.readFileSync(path.join(dir, "previous.json"), "utf8")).toBe(
        `previous v${index + 1}`,
      );
    });
    expect(fixture.warnings.mock.calls.flat().join("")).toContain(
      `recovery ${entry} identity is unknown or changed`,
    );
  });

  it("replaces an existing pair and removes only its recovery artifacts", async () => {
    const fixture = pairFixture();
    const parent = path.dirname(fixture.outputs[0]);
    const parentMode = fs.statSync(parent).mode;
    fs.writeFileSync(path.join(parent, "unrelated"), "preserve");
    await expect(fixture.run()).resolves.toMatchObject({ wrote: true });
    fixture.outputs.forEach((file, index) => {
      expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(index + 1);
      expect(fixture.recovery(index)).toEqual([]);
    });
    expect(fs.statSync(parent).mode).toBe(parentMode);
    expect(fs.readFileSync(path.join(parent, "unrelated"), "utf8")).toBe("preserve");
  });

  it("adds an explicit second output while keeping --out as v1", () => {
    expect(parsePublishModelCatalogArgs(["--out", "v1.json", "--out-v2", "v2.json"])).toEqual({
      dryRun: false,
      pricing: false,
      out: "v1.json",
      outV2: "v2.json",
    });
    expect(() => parsePublishModelCatalogArgs(["--out-v2", "v2.json"])).toThrow("provide --out");
    expect(() => parsePublishModelCatalogArgs(["--out", "v1.json", "--out-v2"])).toThrow(
      "requires a value",
    );
  });

  it("projects only metadata rows with partial costs, tiers, and native tuple identity", async () => {
    const bundle: RemoteModelCatalogBundle = {
      schemaVersion: 1,
      generatedAt: 1,
      sourceCommit: "fixture",
      minVersion: "2026.7.0",
      providers: {
        alpha: {
          models: [
            { id: "vendor/model", cost: { input: 2 } },
            { id: "zero", cost: { input: 0, output: 0 } },
            {
              id: "tier",
              cost: {
                tieredPricing: [{ input: 3, output: 4, cacheRead: 0, cacheWrite: 0, range: [0] }],
              },
            },
          ],
        },
        beta: { models: [{ id: "vendor/model" }] },
      },
      pricing: { "alpha/extra": { input: 9, output: 9 } },
    };
    const before = serializeModelCatalogBundle(bundle);
    const v2 = await assembleModelCatalogBundleV2(bundle, new WeakMap());
    expect(v2.models).toHaveLength(4);
    expect(v2.models[0]).toMatchObject({
      id: "vendor/model",
      provider: "alpha",
      pricing: { status: "known", input: 2 },
    });
    expect(v2.models[0]?.pricing).not.toHaveProperty("source");
    expect(v2.models[0]?.pricing).not.toHaveProperty("output");
    expect(v2.models[1]?.pricing).toEqual({ status: "unknown" });
    expect(v2.models[2]?.pricing).toMatchObject({
      status: "known",
      tieredPricing: bundle.providers.alpha?.models[2]?.cost?.tieredPricing,
    });
    expect(v2.models[3]).toMatchObject({
      id: "vendor/model",
      provider: "beta",
      pricing: { status: "unknown" },
    });
    expect(v2).not.toHaveProperty("pricing");
    expect(v2).not.toHaveProperty("minVersion");
    expect(serializeModelCatalogBundle(bundle)).toBe(before);
    const serialized = serializeModelCatalogBundleV2(v2);
    const parsed = parseRemoteModelCatalogBundleV2(JSON.parse(serialized));
    expect(parsed.models).toHaveLength(4);
    expect(Object.keys(JSON.parse(serialized).models[0]).slice(0, 2)).toEqual(["id", "provider"]);
    expect(serializeModelCatalogBundleV2({ ...v2, models: v2.models.toReversed() })).toBe(
      serialized,
    );
  });

  it("writes paired catalogs from one source snapshot, preserving authoritative zero and withdrawal", async () => {
    const rootDir = fixtureRoot();
    const fetchImpl = fixtureFetch();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runPublishModelCatalog({
      rootDir,
      fetchImpl,
      now: () => 42,
      sourceCommit: "fixture",
      args: ["--pricing", "--out", "v1/catalog.json", "--out-v2", "v2/catalog.json"],
    });
    const v1 = parseRemoteModelCatalogBundle(
      JSON.parse(fs.readFileSync(path.join(rootDir, "v1/catalog.json"), "utf8")),
    );
    const v2 = parseRemoteModelCatalogBundleV2(
      JSON.parse(fs.readFileSync(path.join(rootDir, "v2/catalog.json"), "utf8")),
    );
    expect(v1.generatedAt).toBe(v2.generatedAt);
    expect(v1.sourceCommit).toBe(v2.sourceCommit);
    expect(v1.minVersion).toBe("2026.7.0");
    expect(v2.models).toHaveLength(203);
    expect(v2.providers.openai?.defaultModel).toBe("seed-0");
    expect(v2.providers.openai?.recommendedModels).toEqual(["seed-2", "seed-0"]);
    expect(v1.providers.openai).not.toHaveProperty("recommendedModels");
    expect(v2.providers.anthropic).not.toHaveProperty("recommendedModels");
    expect(
      v2.models.find((model) => model.provider === "anthropic" && model.id === "seed-0")?.pricing,
    ).toEqual({
      status: "known",
      currency: "USD",
      unit: "million_tokens",
      input: 0.5,
      source: "manifest",
    });
    expect(v2.models.find((model) => model.id === "free")?.pricing).toMatchObject({
      status: "known",
      input: 0,
      output: 0,
      source: "openCode",
    });
    expect(v2.models.find((model) => model.id === "paid")?.pricing).toMatchObject({
      status: "known",
      input: 2,
      output: 3,
      source: "openCode",
    });
    expect(v2.models.find((model) => model.id === "withdrawn")?.pricing).toEqual({
      status: "unavailable",
      source: "openCode",
    });
    expect(v1.pricing?.["fixture-native/extra"]).toBeDefined();
    expect(v2.models.some((model) => model.id === "extra")).toBe(false);
    // Each route is priced from the list of whoever bills it (OpenRouter's 50% promotion).
    expect(
      v2.models.find((model) => model.provider === "openai" && model.id === "seed-1")?.pricing,
    ).toMatchObject({ status: "known", input: 4, output: 20, source: "modelsDev" });
    expect(v2.upstreamPricing?.["openai/seed-1"]).toMatchObject({
      input: 4,
      output: 20,
      source: "modelsDev",
      passthroughOnly: true,
    });
    expect(v2.providerPricing?.["openrouter/openai/seed-1"]).toMatchObject({
      input: 2,
      output: 10,
      source: "openRouter",
    });
    expect(v2.providerPricing?.["mygate/openai/seed-1"]).toEqual({
      input: 3,
      output: 9,
      source: "modelsDev",
    });
    expect(v1.pricing?.["gateway/openai/seed-1"]).toMatchObject({ input: 4, output: 20 });
    expect(v1.pricing?.["mygate/openai/seed-1"]).toMatchObject({ input: 3, output: 9 });
    expect(v1.pricing?.["openrouter/openai/seed-1"]).toMatchObject({ input: 2, output: 10 });
    // Standalone v2 rates keep v1's resolvable prices without per-gateway copies.
    expect(v2.providerPricing?.["fixture-native/extra"]).toEqual({
      ...v1.pricing?.["fixture-native/extra"],
      source: "openCode",
    });
    expect(v2.upstreamPricing).not.toHaveProperty("vendorx/model-a");
    // Gateways pass through the vendor's models.dev slug, not its OpenClaw provider ID.
    expect(v2.upstreamPricing?.["moonshotai/kimi-k3"]).toEqual({
      input: 3,
      output: 15,
      source: "modelsDev",
    });
    expect(
      Object.keys({ ...v2.upstreamPricing, ...v2.providerPricing }).some((key) =>
        key.startsWith("mygate-md/"),
      ),
    ).toBe(false);
    expect(
      Object.keys({ ...v2.upstreamPricing, ...v2.providerPricing }).some((key) =>
        key.startsWith("gateway/"),
      ),
    ).toBe(false);
    expect(
      fetchImpl.mock.calls.filter(([url]) => url === "https://models.opencode.ai/api.json"),
    ).toHaveLength(1);
    await runPublishModelCatalog({
      rootDir,
      fetchImpl: fixtureFetch(),
      now: () => 42,
      sourceCommit: "fixture",
      args: ["--pricing", "--out", "v1-only.json"],
    });
    expect(fs.readFileSync(path.join(rootDir, "v1-only.json"), "utf8")).toBe(
      fs.readFileSync(path.join(rootDir, "v1/catalog.json"), "utf8"),
    );
  });

  it("keeps both prior files on source failure and never writes in dry-run mode", async () => {
    const rootDir = fixtureRoot();
    const out = path.join(rootDir, "v1.json");
    const outV2 = path.join(rootDir, "v2.json");
    fs.writeFileSync(out, "previous v1");
    fs.writeFileSync(outV2, "previous v2");
    const args = ["--pricing", "--out", out, "--out-v2", outV2];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      runPublishModelCatalog({
        rootDir,
        sourceCommit: "fixture",
        args,
        fetchImpl: async () => {
          throw new Error("fixture outage");
        },
      }),
    ).rejects.toThrow("fixture outage");
    await runPublishModelCatalog({
      rootDir,
      sourceCommit: "fixture",
      args: [...args, "--dry-run"],
      fetchImpl: fixtureFetch(),
    });
    expect(fs.readFileSync(out, "utf8")).toBe("previous v1");
    expect(fs.readFileSync(outV2, "utf8")).toBe("previous v2");
    await expect(
      runPublishModelCatalog({ rootDir, args: ["--out", "same.json", "--out-v2", "./same.json"] }),
    ).rejects.toThrow("different files");
  });
});
