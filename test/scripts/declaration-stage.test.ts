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
  return { staging, dist, invocation };
}

describe("canonical declaration stage", () => {
  it("retains a sibling failure when another compiler cannot start", async () => {
    const { staging, dist, invocation } = fixture();
    const missing = invocation({});
    missing.command = path.join(staging, "missing-compiler");
    const failed = invocation({}, 17);
    const result = await publishStagedDeclarations(
      {
        env: process.env,
        maxOldSpaceMb: 8192,
        heapShortfall: null,
        invocations: [missing, failed],
      },
      [],
      staging,
      dist,
      ["plugin-sdk/core.d.ts"],
      ["plugin-sdk/obsolete.d.ts"],
      undefined,
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
  });

  it.each(["success", "exit", "dual-exit", "diagnostic"])(
    "joins both private compiler stages before %s publication",
    async (outcome) => {
      const { staging, dist, invocation } = fixture();
      const root = path.dirname(staging);
      const sources = ["public", "private"].map((name) => ({
        output: path.join(root, name),
        required: [`plugin-sdk/${name}.d.ts`],
      }));
      const invocations = sources.map((source, index) => {
        const child = invocation({ [source.required[0]!]: "export {};" }, 0, source.output);
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
              if (['exit', 'dual-exit'].includes(${JSON.stringify(outcome)})) process.exitCode = 17;
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
                if (${JSON.stringify(outcome)} === 'dual-exit') process.exitCode = 23;
              }, 10);
            }
          }, 10);
        `;
        return child;
      });
      const seal = vi.fn(() => {
        expect(fs.existsSync(path.join(root, "second.finished"))).toBe(true);
        expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
      });
      const publication = publishStagedDeclarations(
        { env: process.env, maxOldSpaceMb: 8192, heapShortfall: null, invocations },
        sources,
        staging,
        dist,
        sources.flatMap((source) => source.required),
        ["plugin-sdk/obsolete.d.ts"],
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
        if (outcome === "dual-exit") {
          const result = await publication.catch((error: unknown) => error);
          expect(result).toBeInstanceOf(AggregateError);
          expect(result).toMatchObject({
            errors: expect.arrayContaining([
              expect.objectContaining({
                message: "tsdown invocation 1 failed with exit 17",
                exitCode: 17,
              }),
              expect.objectContaining({
                message: "tsdown invocation 2 failed with exit 23",
                exitCode: 23,
              }),
            ]),
          });
        } else {
          await expect(publication).rejects.toThrow(
            `Declaration build failed with exit ${outcome === "exit" ? 17 : 1}`,
          );
        }
        expect(seal).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
        for (const source of sources) {
          expect(fs.existsSync(path.join(dist, source.required[0]!))).toBe(false);
        }
      }
      expect(fs.readFileSync(path.join(root, "second.finished"), "utf8")).toBe("finished");
    },
  );

  it.each([".d.ts", ".d.mts", ".d.cts"])(
    "strips undeclared __exportAll from staged %s declaration exports",
    async (extension) => {
      const { staging, dist, invocation } = fixture();
      await publishStagedDeclarations(
        {
          env: process.env,
          maxOldSpaceMb: 8192,
          heapShortfall: null,
          invocations: [
            invocation({
              [`plugin-sdk/core${extension}`]:
                "export declare const keep: number;\nexport { keep as k, __exportAll as ud };\n",
            }),
          ],
        },
        [],
        staging,
        dist,
        [`plugin-sdk/core${extension}`],
        ["plugin-sdk/obsolete.d.ts"],
      );
      const published = fs.readFileSync(path.join(dist, `plugin-sdk/core${extension}`), "utf8");
      expect(published).toContain("keep as k");
      expect(published).not.toContain("__exportAll");
    },
  );

  it.each([".d.ts", ".d.mts", ".d.cts"])(
    "also strips undeclared __exportAll left in live dist outside staging (%s)",
    async (extension) => {
      const { staging, dist, invocation } = fixture();
      fs.writeFileSync(
        path.join(dist, `leftover-chunk${extension}`),
        "export declare const keep: number;\nexport { keep as k, __exportAll as ud };\n",
      );
      await publishStagedDeclarations(
        {
          env: process.env,
          maxOldSpaceMb: 8192,
          heapShortfall: null,
          invocations: [
            invocation({
              "plugin-sdk/core.d.ts": "export declare const ok: true;\n",
            }),
          ],
        },
        [],
        staging,
        dist,
        ["plugin-sdk/core.d.ts"],
        ["plugin-sdk/obsolete.d.ts"],
      );
      const leftover = fs.readFileSync(path.join(dist, `leftover-chunk${extension}`), "utf8");
      expect(leftover).toContain("keep as k");
      expect(leftover).not.toContain("__exportAll");
    },
  );

  it("rejects absolute reference paths even when a staged relative namesake exists", async () => {
    const { staging, dist, invocation } = fixture();
    await expect(
      publishStagedDeclarations(
        {
          env: process.env,
          maxOldSpaceMb: 8192,
          heapShortfall: null,
          invocations: [
            invocation({
              "plugin-sdk/core.d.ts": '/// <reference path="/shared.d.ts" />\nexport {};',
              "plugin-sdk/shared.d.ts": "export {};",
            }),
          ],
        },
        [],
        staging,
        dist,
        ["plugin-sdk/core.d.ts"],
        ["plugin-sdk/obsolete.d.ts"],
      ),
    ).rejects.toThrow("Incomplete declaration closure");
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });
  it.each([
    '/// <reference path="./missing.d.ts" />\nexport {};',
    'import Type = require("./missing.cjs"); export { Type };',
    'export * as Types from "./missing.js";',
    'export type Type = import("./missing.js").Type;',
  ])("rejects a missing relative dependency in %s", async (declaration) => {
    const { staging, dist, invocation } = fixture();
    await expect(
      publishStagedDeclarations(
        {
          env: process.env,
          maxOldSpaceMb: 8192,
          heapShortfall: null,
          invocations: [invocation({ "plugin-sdk/core.d.ts": declaration })],
        },
        [],
        staging,
        dist,
        ["plugin-sdk/core.d.ts"],
        ["plugin-sdk/obsolete.d.ts"],
      ),
    ).rejects.toThrow("Incomplete declaration closure");
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });

  it("ignores imports in comments while preserving an actual reference directive", async () => {
    const { staging, dist, invocation } = fixture();
    const files = {
      "plugin-sdk/core.d.ts":
        '/// <reference path="../shared.d.ts" />\n// import type {Absent} from "./not-an-import.js";\nexport {};',
      "shared.d.ts": "export {};",
    };
    await publishStagedDeclarations(
      {
        env: process.env,
        maxOldSpaceMb: 8192,
        heapShortfall: null,
        invocations: [invocation(files)],
      },
      [],
      staging,
      dist,
      ["plugin-sdk/core.d.ts"],
      ["plugin-sdk/obsolete.d.ts"],
    );
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/core.d.ts"), "utf8")).toBe(
      files["plugin-sdk/core.d.ts"],
    );
  });
  it.skipIf(process.platform === "win32")(
    "does not mask a timeout when the child exits zero on SIGTERM",
    async () => {
      const { staging, dist, invocation } = fixture();
      vi.stubEnv("OPENCLAW_TSDOWN_TIMEOUT_MS", "1500");
      vi.stubEnv("OPENCLAW_TSDOWN_HEARTBEAT_MS", "0");
      const first = invocation({});
      first.args = [
        "-e",
        `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.mkdirSync(${JSON.stringify(staging)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(staging, "ready"))},'ready');setInterval(()=>{},1000);`,
      ];
      await expect(
        publishStagedDeclarations(
          {
            env: process.env,
            maxOldSpaceMb: 8192,
            heapShortfall: null,
            invocations: [first, invocation({ "later.d.ts": "export {};" })],
          },
          [],
          staging,
          dist,
          [],
          ["plugin-sdk/obsolete.d.ts"],
        ),
      ).rejects.toMatchObject({ exitCode: 124 });
      expect(fs.existsSync(path.join(staging, "ready"))).toBe(true);
      expect(fs.existsSync(path.join(staging, "later.d.ts"))).toBe(false);
      expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
    },
  );
  it.each(["child failure", "missing entry", "missing nested chunk"])(
    "does not publish on %s",
    async (failure) => {
      const { staging, dist, invocation } = fixture();
      const plan = {
        env: process.env,
        maxOldSpaceMb: 8192,
        heapShortfall: null,
        invocations: [
          invocation({ "plugin-sdk/public.d.ts": 'export type { Shared } from "../shared.js";' }),
          invocation(
            failure === "missing nested chunk"
              ? { "plugin-sdk/private.d.ts": "export {};" }
              : { "shared.d.ts": "export type Shared = string;" },
            failure === "child failure" ? 2 : 0,
          ),
        ],
      };
      const before = fs.readdirSync(dist, { recursive: true }).map(String).toSorted();
      await expect(
        publishStagedDeclarations(
          plan,
          [],
          staging,
          dist,
          ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"],
          ["plugin-sdk/obsolete.d.ts"],
        ),
      ).rejects.toThrow();
      expect(fs.readdirSync(dist, { recursive: true }).map(String).toSorted()).toEqual(before);
      expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
    },
  );

  it("publishes both groups with root chunks, preserves unrelated files, and prunes only owned entries", async () => {
    const { staging, dist, invocation } = fixture();
    const first = path.join(staging, "..", "first");
    const second = path.join(staging, "..", "second");
    const publicFile = {
      "plugin-sdk/public.d.ts": 'export type { Shared } from "../shared.js";',
      "shared.d.ts": 'export type Shared = import("./z-leaf.js").Leaf;',
      "z-leaf.d.ts": "export type Leaf = string;",
    };
    const plan = {
      env: process.env,
      maxOldSpaceMb: 8192,
      heapShortfall: null,
      invocations: [
        invocation(publicFile, 0, first),
        invocation(
          {
            "plugin-sdk/private.d.ts": 'export type { Shared } from "../shared.js";',
            "shared.d.ts": publicFile["shared.d.ts"],
          },
          0,
          second,
        ),
      ],
    };
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
      await publishStagedDeclarations(
        plan,
        [
          { output: first, required: ["plugin-sdk/public.d.ts"] },
          { output: second, required: ["plugin-sdk/private.d.ts"] },
        ],
        staging,
        dist,
        ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"],
        ["plugin-sdk/obsolete.d.ts"],
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
    await publishStagedDeclarations(
      { ...plan, invocations: [invocation(publicFile)] },
      [],
      staging,
      dist,
      ["plugin-sdk/public.d.ts"],
      ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"],
    );
    expect(fs.existsSync(path.join(dist, "plugin-sdk/private.d.ts"))).toBe(false);
    expect(fs.statSync(path.join(dist, "plugin-sdk/public.d.ts")).mtimeMs).toBe(unchanged);
  });

  it.each(["conflicting shared bytes", "misassigned entry"])(
    "rejects canonical group ownership with %s before publishing",
    async (failure) => {
      const { staging, dist, invocation } = fixture();
      const first = path.join(staging, "..", "first");
      const second = path.join(staging, "..", "second");
      const publicFile = { "plugin-sdk/public.d.ts": "export {};" };
      await expect(
        publishStagedDeclarations(
          {
            env: process.env,
            maxOldSpaceMb: 8192,
            heapShortfall: null,
            invocations: [
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
          },
          [
            { output: first, required: ["plugin-sdk/public.d.ts"] },
            { output: second, required: ["plugin-sdk/private.d.ts"] },
          ],
          staging,
          dist,
          ["plugin-sdk/public.d.ts", "plugin-sdk/private.d.ts"],
          ["plugin-sdk/obsolete.d.ts"],
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
