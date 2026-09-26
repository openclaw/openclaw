import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "./helpers/fixture-lifetime.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
const source = process.cwd();
const publishedScript = path.join(source, "test/scripts/fixtures/update-gateway-2026.9.4.sh");
// Exact 3a9d69db306cd7f081e06254cb89c4bcc14a7107 bytes; never patch the running old driver.
const publishedSha256 = "944d24f53a4f6b4134326d6d3dc5fe135ab5524d7fdccd2af5b85572e00db652";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });

it.skipIf(process.platform === "win32").for([
  { mode: "default", restart: undefined, code: 0, owns: true },
  { mode: "custom", restart: "  custom-restart  ", code: 0, owns: true },
  { mode: "manual", restart: "", code: 1, owns: false },
  { mode: "whitespace", restart: " \t", code: 1, owns: false },
  { mode: "disjoint", restart: undefined, code: 0, owns: false },
  { mode: "sibling", restart: undefined, code: 1, owns: false },
  { mode: "unavailable", restart: undefined, code: 1, owns: false },
  { mode: "explicit-profile", restart: undefined, code: 1, owns: false },
  { mode: "failure", restart: "custom-restart", code: 17, owns: true },
  { mode: "unjoined", restart: undefined, code: 1, owns: true },
  { mode: "enable-failure", restart: undefined, code: 1, owns: true },
  { mode: "partial-stop", restart: undefined, code: 1, owns: true },
  { mode: "partial-stop-custom", restart: "custom-restart", code: 1, owns: true },
  { mode: "partial-stop-drift", restart: "custom-restart", code: 1, owns: true },
  { mode: "partial-stop-scheduled", restart: "custom-restart", code: 1, owns: true },
  { mode: "native-unjoined", restart: undefined, code: 1, owns: true },
  { mode: "drift", restart: undefined, code: 1, owns: true },
  { mode: "begin-abort", restart: undefined, code: 1, owns: true },
  { mode: "begin-closed", restart: undefined, code: 1, owns: true },
  { mode: "begin-delegated", restart: undefined, code: 1, owns: true },
  { mode: "begin-lost", restart: undefined, code: 1, owns: true },
  { mode: "begin-unjoined", restart: undefined, code: 1, owns: true },
  { mode: "build-throw-settle", restart: undefined, code: 1, owns: true },
  { mode: "build-throw-restart", restart: undefined, code: 1, owns: true },
  { mode: "build-throw-restore", restart: undefined, code: 1, owns: true },
])(
  "published source shell reaches candidate build entry: $mode",
  async ({ mode, restart, code, owns }, { signal }) => {
    await lifetime.run(async () => {
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-legacy-source-build-"));
      const seed = path.join(root, "seed");
      const checkout = path.join(root, "checkout");
      const bin = path.join(root, "bin");
      const home = path.join(root, "home");
      for (const dir of [path.join(seed, "scripts"), bin, home]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const bytes = fs.readFileSync(publishedScript);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(publishedSha256);
      fs.writeFileSync(path.join(seed, "scripts/update-gateway.sh"), bytes);
      fs.writeFileSync(
        path.join(seed, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0", packageManager: "pnpm@12.4.2" }),
      );
      fs.writeFileSync(
        path.join(seed, ".gitignore"),
        "dist/\n.artifacts/\n.update-build-backup.*/\nforeign/\nevents\nstopped\nbuild-env.json\n",
      );
      git(seed, "init", "-q", "-b", "main");
      git(seed, "add", ".");
      git(
        seed,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-qm",
        "published shell",
      );
      git(root, "clone", "-q", seed, checkout);
      fs.writeFileSync(path.join(seed, "candidate"), "candidate\n");
      git(seed, "add", "candidate");
      git(
        seed,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-qm",
        "candidate",
      );
      for (const base of [checkout, path.join(checkout, "foreign")]) {
        fs.mkdirSync(path.join(base, "dist"), { recursive: true });
        fs.writeFileSync(path.join(base, "dist/entry.js"), "old runtime\n");
        if (base !== checkout) {
          fs.writeFileSync(path.join(base, "package.json"), '{"name":"openclaw"}');
        }
      }
      const shim = (name: string, body: string) => {
        const file = path.join(bin, name);
        fs.writeFileSync(file, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
        fs.chmodSync(file, 0o755);
      };
      shim("corepack", 'ln -s "$LEGACY_FIXTURE_BIN/pnpm" "$3/pnpm"');
      shim(
        "pnpm",
        `if [ "$1" = --version ]; then echo 12.4.2; exit 0; fi
if [ "$1" = install ]; then exit 0; fi
export npm_execpath="$LEGACY_FIXTURE_BIN/pnpm.cjs"
exec "$LEGACY_FIXTURE_NODE" --import "$LEGACY_FIXTURE_SOURCE/scripts/tsx.mjs" --import "$LEGACY_FIXTURE_LOADER" "$LEGACY_FIXTURE_SOURCE/scripts/build-all.mts" "$LEGACY_FIXTURE_PROFILE"`,
      );
      for (const name of ["openclaw", "custom-restart"]) {
        shim(
          name,
          `echo restart >> "$LEGACY_FIXTURE_ROOT/events"
if [ "$LEGACY_FIXTURE_MODE" = build-throw-restart ]; then exit 23; fi`,
        );
      }
      const result = await lifetime.track(
        runVitestShutdownCommand({
          bin: "/bin/bash",
          args: [path.join(checkout, "scripts/update-gateway.sh")],
          cwd: checkout,
          signal,
          env: {
            PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
            HOME: home,
            TMPDIR: root,
            OPENCLAW_PROFILE: "selected",
            OPENCLAW_BUILD_CACHE: "0",
            LEGACY_FIXTURE_SOURCE: source,
            LEGACY_FIXTURE_LOADER: new URL(
              "./scripts/fixtures/legacy-source-build.mjs",
              import.meta.url,
            ).href,
            LEGACY_FIXTURE_ROOT: checkout,
            LEGACY_FIXTURE_BIN: bin,
            LEGACY_FIXTURE_NODE: process.execPath,
            LEGACY_FIXTURE_MODE: mode,
            LEGACY_FIXTURE_PROFILE: mode === "explicit-profile" ? "qaRuntime" : "full",
            ...(restart === undefined ? {} : { OPENCLAW_UPDATE_RESTART_CMD: restart }),
          },
        }),
      );
      expect(result.code, result.stderr).toBe(code);
      const events = fs.existsSync(path.join(checkout, "events"))
        ? fs.readFileSync(path.join(checkout, "events"), "utf8").trim().split("\n")
        : [];
      expect(events.filter((event) => event === "stop")).toHaveLength(owns ? 1 : 0);
      if (["manual", "whitespace", "sibling", "unavailable", "explicit-profile"].includes(mode)) {
        expect(result.stderr).toContain("Refusing to rebuild dist");
        expect(events).toEqual([]);
      } else if (mode.startsWith("build-throw-")) {
        expect(result.stderr).toContain("fixture compiler rejected");
        expect(
          fs.readdirSync(checkout).some((name) => name.startsWith(".update-build-backup.")),
        ).toBe(true);
        if (mode === "build-throw-restore") {
          expect(result.stderr).toContain("could not be fully restored");
          expect(events).toEqual(["stop", "mutation", "build", "complete:false"]);
          expect(fs.lstatSync(path.join(checkout, "dist")).isSymbolicLink()).toBe(true);
          expect(fs.readFileSync(path.join(checkout, "foreign/dist/entry.js"), "utf8")).toBe(
            "old runtime\n",
          );
        } else {
          expect(result.stderr).toContain(
            mode === "build-throw-settle"
              ? "fixture native completion failed"
              : "restart failed (23)",
          );
          expect(events).toEqual([
            "stop",
            "mutation",
            "build",
            "enable",
            "restart",
            ...(mode === "build-throw-settle" ? ["complete:true"] : ["complete:false", "disable"]),
          ]);
          expect(fs.readFileSync(path.join(checkout, "dist/entry.js"), "utf8")).toBe(
            "old runtime\n",
          );
        }
      } else if (mode.startsWith("begin-")) {
        expect(result.stderr).toContain("openclaw-update-abort");
        expect(fs.readFileSync(path.join(checkout, "dist/entry.js"), "utf8")).toBe("old runtime\n");
        expect(
          fs.readdirSync(checkout).some((name) => name.startsWith(".update-build-backup.")),
        ).toBe(false);
        if (mode === "begin-abort") {
          expect(events).toEqual(["stop", "mutation", "enable", "restart", "complete:true"]);
        } else if (mode === "begin-unjoined") {
          expect(events).toEqual([
            "stop",
            "mutation",
            "enable",
            "restart-unjoined",
            "complete:false",
            "disable",
          ]);
          expect(
            fs.existsSync(path.join(checkout, ".artifacts/dist-artifacts.lock/owner.json")),
          ).toBe(true);
        } else {
          expect(events).toEqual([
            "stop",
            "mutation",
            mode === "begin-lost" ? "complete:false" : "complete:true",
          ]);
          expect(result.stderr).toContain(`fixture recovery ${mode.slice(6)}`);
        }
      } else if (mode === "native-unjoined") {
        expect(events).toEqual(["stop"]);
        expect(result.stderr).toContain("Native source-update cleanup is unverified");
        expect(
          fs.existsSync(path.join(checkout, ".artifacts/dist-artifacts.lock/owner.json")),
        ).toBe(true);
      } else if (mode.startsWith("partial-stop")) {
        expect(events, result.stderr).toEqual([
          "stop",
          "native-admission",
          ...(mode === "partial-stop-drift" ? [] : ["native-restart"]),
        ]);
        expect(result.stderr).toContain("fixture stop rejected after native mutation");
        if (mode === "partial-stop-drift") {
          expect(result.stderr).toContain("native fingerprint changed");
        } else if (mode === "partial-stop-scheduled") {
          expect(result.stderr).toMatch(/scheduled|not completed/i);
        }
        expect(fs.readFileSync(path.join(checkout, "dist/entry.js"), "utf8")).toBe("old runtime\n");
        expect(
          fs.readdirSync(checkout).some((name) => name.startsWith(".update-build-backup.")),
        ).toBe(false);
      } else if (mode === "drift") {
        expect(events).toEqual(["stop", "mutation", "build", "complete:false"]);
        expect(result.stderr).toContain("native fingerprint changed");
        expect(
          fs.readdirSync(checkout).some((name) => name.startsWith(".update-build-backup.")),
        ).toBe(true);
      } else if (mode === "unjoined") {
        expect(events).toEqual(["stop", "mutation", "build", "complete:false"]);
        expect(
          fs.readdirSync(checkout).some((name) => name.startsWith(".update-build-backup.")),
        ).toBe(true);
      } else if (mode === "enable-failure") {
        expect(events).toEqual([
          "stop",
          "mutation",
          "build",
          "enable",
          "complete:false",
          "disable",
        ]);
        expect(
          fs.readdirSync(checkout).some((name) => name.startsWith(".update-build-backup.")),
        ).toBe(true);
      } else {
        expect(events).toEqual(
          owns
            ? [
                "stop",
                "mutation",
                "build",
                "enable",
                ...(mode === "failure"
                  ? ["restart", "complete:true"]
                  : ["complete:true", "restart"]),
              ]
            : ["build", "restart"],
        );
        expect(fs.readFileSync(path.join(checkout, "dist/entry.js"), "utf8")).toBe(
          mode === "failure" ? "old runtime\n" : "new runtime\n",
        );
        const buildEnv = JSON.parse(fs.readFileSync(path.join(checkout, "build-env.json"), "utf8"));
        expect(buildEnv.npm_execpath).toBe(path.join(bin, "pnpm.cjs"));
        expect(buildEnv.workspace).toBe(checkout);
      }
    });
  },
);
