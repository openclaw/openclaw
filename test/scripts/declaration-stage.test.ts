import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishStagedDeclarations } from "../../scripts/lib/declaration-stage.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const root = fs.realpathSync(roots.make("declaration-stage-"));
  const staging = path.join(root, "staging");
  const dist = path.join(root, "dist");
  function write(base: string, file: string, text: string) {
    const target = path.join(base, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  write(dist, "plugin-sdk/obsolete.d.ts", "old");
  write(dist, "core.d.ts", "core");
  write(dist, "shared-old.d.ts", "unattributed");
  write(dist, "runtime.js", "runtime");
  const invocation = (files: Record<string, string>, exitCode = 0, output = staging) => ({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs'),path=require('node:path'); for(const [file,bytes] of Object.entries(${JSON.stringify(files)})){const p=path.join(${JSON.stringify(output)},file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);} process.exitCode=${exitCode};`,
    ],
    options: { stdio: ["ignore", "pipe", "pipe"], shell: false, env: process.env },
  });
  const publish = (
    invocations: NonNullable<Parameters<typeof publishStagedDeclarations>[0]>["invocations"],
    required = ["plugin-sdk/core.d.ts"],
    sources: Parameters<typeof publishStagedDeclarations>[1] = [],
    seal?: () => void,
    concurrency: 1 | 2 = 1,
    previous = ["plugin-sdk/obsolete.d.ts"],
  ) =>
    publishStagedDeclarations(
      { env: process.env, maxOldSpaceMb: 8192, heapShortfall: null, invocations },
      sources,
      staging,
      dist,
      required,
      previous,
      seal,
      concurrency,
    );
  return { staging, dist, invocation, publish };
}

describe("canonical declaration stage", () => {
  it("retains a sibling failure and stops queued work when another compiler cannot start", async () => {
    const { staging, dist, invocation, publish } = fixture();
    const missing = invocation({});
    missing.command = path.join(staging, "missing-compiler");
    const failed = invocation({}, 17);
    const seal = vi.fn();
    const result = await publish(
      [missing, failed, invocation({ "queued.d.ts": "export {};" })],
      ["plugin-sdk/core.d.ts"],
      [],
      seal,
      2,
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "ENOENT" }),
        expect.objectContaining({ exitCode: 17 }),
      ]),
    });
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(staging, "queued.d.ts"))).toBe(false);
    expect(seal).not.toHaveBeenCalled();
  });

  it.each(["success", "diagnostic"])(
    "joins every private compiler stage before %s publication",
    async (outcome) => {
      const { staging, dist, invocation, publish } = fixture();
      const root = path.dirname(staging);
      const names = outcome === "success" ? ["public", "private", "queued"] : ["public", "private"];
      const sources = names.map((name) => ({
        output: path.join(root, name),
        required: [`plugin-sdk/${name}.d.ts`],
      }));
      const invocations = sources.map((source, index) => {
        const child = invocation({ [source.required[0]!]: "export {};" }, 0, source.output);
        if (index === 2) {
          return child;
        }
        child.args[1] = `
          const fs = require('node:fs'), path = require('node:path');
          const root = ${JSON.stringify(root)}, index = ${index};
          fs.writeFileSync(path.join(root, index + '.started'), 'started');
          const deadline = Date.now() + 3000;
          const wait = setInterval(() => {
            if (!fs.existsSync(path.join(root, (1 - index) + '.started'))) {
              if (Date.now() > deadline) { clearInterval(wait); process.exitCode = 73; }
              return;
            }
            clearInterval(wait);
            { ${child.args[1]} }
            if (index === 0) {
              if (${JSON.stringify(outcome)} === 'diagnostic') console.error('[INEFFECTIVE_DYNAMIC_IMPORT]');
              fs.writeFileSync(path.join(root, 'first.finished'), 'finished');
            } else {
              const drain = setInterval(() => {
                if (!fs.existsSync(path.join(root, 'first.finished'))) {
                  if (Date.now() > deadline) { clearInterval(drain); process.exitCode = 74; }
                  return;
                }
                clearInterval(drain);
                fs.writeFileSync(path.join(root, 'second.finished'), 'finished');
              }, 10);
            }
          }, 10);
        `;
        return child;
      });
      const seal = vi.fn(() => {
        expect(fs.existsSync(path.join(root, "second.finished"))).toBe(true);
        for (const source of sources) {
          expect(fs.existsSync(path.join(source.output, source.required[0]!))).toBe(true);
        }
        expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
      });
      const publication = publish(
        invocations,
        sources.flatMap((source) => source.required),
        sources,
        seal,
        2,
      );
      if (outcome === "success") {
        await publication;
        expect(seal).toHaveBeenCalledOnce();
        for (const source of sources) {
          expect(fs.readFileSync(path.join(dist, source.required[0]!), "utf8")).toBe("export {};");
        }
      } else {
        await expect(publication).rejects.toThrow("Declaration build failed with exit 1");
        expect(seal).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
        for (const source of sources) {
          expect(fs.existsSync(path.join(dist, source.required[0]!))).toBe(false);
        }
      }
      expect(fs.readFileSync(path.join(root, "second.finished"), "utf8")).toBe("finished");
    },
  );

  it("strips undeclared __exportAll from staged declaration exports", async () => {
    const { dist, invocation, publish } = fixture();
    await publish([
      invocation({
        "plugin-sdk/core.d.ts":
          "export declare const keep: number;\nexport { keep as k, __exportAll as ud };\n",
      }),
    ]);
    const published = fs.readFileSync(path.join(dist, "plugin-sdk/core.d.ts"), "utf8");
    expect(published).toContain("keep as k");
    expect(published).not.toContain("__exportAll");
  });

  it("also strips undeclared __exportAll left in live dist outside staging", async () => {
    const { dist, invocation, publish } = fixture();
    fs.writeFileSync(
      path.join(dist, "leftover-chunk.d.ts"),
      "export declare const keep: number;\nexport { keep as k, __exportAll as ud };\n",
    );
    await publish([
      invocation({
        "plugin-sdk/core.d.ts": "export declare const ok: true;\n",
      }),
    ]);
    const leftover = fs.readFileSync(path.join(dist, "leftover-chunk.d.ts"), "utf8");
    expect(leftover).toContain("keep as k");
    expect(leftover).not.toContain("__exportAll");
  });

  it("rejects absolute reference paths even when a staged relative namesake exists", async () => {
    const { dist, invocation, publish } = fixture();
    await expect(
      publish([
        invocation({
          "plugin-sdk/core.d.ts": '/// <reference path="/shared.d.ts" />\nexport {};',
          "plugin-sdk/shared.d.ts": "export {};",
        }),
      ]),
    ).rejects.toThrow("Incomplete declaration closure");
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });
  it("rejects a missing relative import-equals dependency", async () => {
    const declaration = 'import Type = require("./missing.cjs"); export { Type };';
    const { dist, invocation, publish } = fixture();
    await expect(publish([invocation({ "plugin-sdk/core.d.ts": declaration })])).rejects.toThrow(
      "Incomplete declaration closure",
    );
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });

  it.skipIf(process.platform === "win32")(
    "does not mask a timeout when the child exits zero on SIGTERM",
    async () => {
      const { staging, dist, invocation, publish } = fixture();
      vi.stubEnv("OPENCLAW_TSDOWN_TIMEOUT_MS", "1500");
      vi.stubEnv("OPENCLAW_TSDOWN_HEARTBEAT_MS", "0");
      const first = invocation({});
      first.args = [
        "-e",
        `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.mkdirSync(${JSON.stringify(staging)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(staging, "ready"))},'ready');setInterval(()=>{},1000);`,
      ];
      await expect(
        publish([first, invocation({ "later.d.ts": "export {};" })], []),
      ).rejects.toMatchObject({ exitCode: 124 });
      expect(fs.existsSync(path.join(staging, "ready"))).toBe(true);
      expect(fs.existsSync(path.join(staging, "later.d.ts"))).toBe(false);
      expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
    },
  );
  it("does not publish on missing entry", async () => {
    const { dist, invocation, publish } = fixture();
    const invocations = [
      invocation({ "plugin-sdk/public.d.ts": 'export type { Shared } from "../shared.js";' }),
      invocation({ "shared.d.ts": "export type Shared = string;" }),
    ];
    const before = fs.readdirSync(dist, { recursive: true }).map(String).toSorted();
    await expect(
      publish(invocations, ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"]),
    ).rejects.toThrow();
    expect(fs.readdirSync(dist, { recursive: true }).map(String).toSorted()).toEqual(before);
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });

  it("publishes both groups with root chunks, preserves unrelated files, and prunes only owned entries", async () => {
    const { staging, dist, invocation, publish } = fixture();
    const first = path.join(staging, "..", "first");
    const second = path.join(staging, "..", "second");
    const publicFile = {
      "plugin-sdk/public.d.ts": 'export type { Shared } from "../shared.js";',
      "shared.d.ts": 'export type Shared = import("./z-leaf.js").Leaf;',
      "z-leaf.d.ts": "export type Leaf = string;",
    };
    const invocations = [
      invocation(publicFile, 0, first),
      invocation(
        {
          "plugin-sdk/private.d.ts": 'export type { Shared } from "../shared.js";',
          "shared.d.ts": publicFile["shared.d.ts"],
        },
        0,
        second,
      ),
    ];
    const rename = fs.renameSync;
    const observed: string[] = [];
    const publication = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (
        target === path.join(dist, "plugin-sdk/public.d.ts") ||
        target === path.join(dist, "plugin-sdk/private.d.ts")
      ) {
        observed.push(
          fs.existsSync(path.join(dist, "shared.d.ts")) ? "dependency ready" : "missing dependency",
        );
      }
      if (target === path.join(dist, "shared.d.ts")) {
        observed.push(
          fs.existsSync(path.join(dist, "z-leaf.d.ts")) ? "leaf ready" : "missing leaf",
        );
      }
      rename(source, target);
    });
    try {
      await publish(
        invocations,
        ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"],
        [
          { output: first, required: ["plugin-sdk/public.d.ts"] },
          { output: second, required: ["plugin-sdk/private.d.ts"] },
        ],
      );
    } finally {
      publication.mockRestore();
    }
    expect(observed).toEqual(["leaf ready", "dependency ready", "dependency ready"]);
    expect(fs.existsSync(path.join(dist, "plugin-sdk/obsolete.d.ts"))).toBe(false);
    for (const [file, bytes] of Object.entries({
      ...publicFile,
      "core.d.ts": "core",
      "shared-old.d.ts": "unattributed",
      "runtime.js": "runtime",
    })) {
      expect(fs.readFileSync(path.join(dist, file), "utf8")).toBe(bytes);
    }
    const unchanged = fs.statSync(path.join(dist, "plugin-sdk/public.d.ts")).mtimeMs;
    fs.rmSync(staging, { recursive: true });
    await publish([invocation(publicFile)], ["plugin-sdk/public.d.ts"], [], undefined, 1, [
      "plugin-sdk/public.d.ts",
      "plugin-sdk/private.d.ts",
    ]);
    expect(fs.existsSync(path.join(dist, "plugin-sdk/private.d.ts"))).toBe(false);
    expect(fs.statSync(path.join(dist, "plugin-sdk/public.d.ts")).mtimeMs).toBe(unchanged);
  });

  it.each(["conflicting shared bytes", "misassigned entry"])(
    "rejects canonical group ownership with %s before publishing",
    async (failure) => {
      const { staging, dist, invocation, publish } = fixture();
      const first = path.join(staging, "..", "first");
      const second = path.join(staging, "..", "second");
      const publicFile = { "plugin-sdk/public.d.ts": "export {};" };
      await expect(
        publish(
          [
            invocation(
              {
                ...(failure === "misassigned entry" ? {} : publicFile),
                "shared.d.ts": "export type Shared = string;",
              },
              0,
              first,
            ),
            invocation(
              {
                ...(failure === "misassigned entry" ? publicFile : {}),
                "plugin-sdk/private.d.ts": "export {};",
                "shared.d.ts":
                  failure === "conflicting shared bytes"
                    ? "export type Shared = number;"
                    : "export type Shared = string;",
              },
              0,
              second,
            ),
          ],
          ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"],
          [
            { output: first, required: ["plugin-sdk/public.d.ts"] },
            { output: second, required: ["plugin-sdk/private.d.ts"] },
          ],
        ),
      ).rejects.toThrow(
        failure === "conflicting shared bytes"
          ? "Conflicting canonical declaration owners"
          : "Missing canonical declaration",
      );
      expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
      expect(fs.existsSync(path.join(dist, "plugin-sdk/public.d.ts"))).toBe(false);
      expect(fs.existsSync(path.join(dist, "plugin-sdk/private.d.ts"))).toBe(false);
    },
  );
});
