import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { copyTreeCloseOnExec } from "./helpers/close-on-exec-copy.js";
import { createFixtureLifetime } from "./helpers/fixture-lifetime.js";
import { requireNodeTool } from "./helpers/node-toolchain.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
const suiteLifetime = createFixtureLifetime();
afterAll(() => suiteLifetime.cleanup());
const source = process.cwd();
const nodeExecPath = requireNodeTool("node");
const publishedScript = path.join(source, "test/scripts/fixtures/update-gateway-2026.9.4.sh");
// Exact 3a9d69db306cd7f081e06254cb89c4bcc14a7107 bytes; never patch the running old driver.
const publishedSha256 = "944d24f53a4f6b4134326d6d3dc5fe135ab5524d7fdccd2af5b85572e00db652";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
const commitFixture = (cwd: string, message: string) =>
  git(cwd, "commit", "--no-gpg-sign", "-qm", message);
let preparedCheckout: string;

beforeAll(() => {
  if (process.platform === "win32") {
    return;
  }
  const root = fs.realpathSync(suiteLifetime.createTempDir("openclaw-legacy-source-template-"));
  const seed = path.join(root, "seed");
  preparedCheckout = path.join(root, "checkout");
  fs.mkdirSync(path.join(seed, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(seed, "scripts/update-gateway.sh"), fs.readFileSync(publishedScript));
  fs.writeFileSync(
    path.join(seed, "package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0", packageManager: "pnpm@12.4.2" }),
  );
  fs.writeFileSync(
    path.join(seed, ".gitignore"),
    "dist/\n.artifacts/\n.update-build-backup.*/\nforeign/\nevents\nstopped\nbuild-env.json\n",
  );
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@example.invalid");
  git(seed, "add", ".");
  commitFixture(seed, "published shell");
  git(root, "clone", "-q", seed, preparedCheckout);
  fs.writeFileSync(path.join(seed, "candidate"), "candidate\n");
  git(seed, "add", "candidate");
  commitFixture(seed, "candidate");
});

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
  { mode: "failure-drift", restart: "custom-restart", code: 1, owns: true },
  { mode: "failure-scheduled", restart: "custom-restart", code: 1, owns: true },
  { mode: "failure-revoked", restart: "custom-restart", code: 1, owns: true },
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
  ({ mode, restart, code, owns }, { signal }) =>
    lifetime.run(async () => {
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-legacy-source-build-"));
      const checkout = path.join(root, "checkout");
      const bin = path.join(root, "bin");
      const home = path.join(root, "home");
      for (const dir of [bin, home]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const bytes = fs.readFileSync(publishedScript);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(publishedSha256);
      copyTreeCloseOnExec(preparedCheckout, checkout);
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
        shim(name, 'echo restart >> "$LEGACY_FIXTURE_ROOT/events"');
      }
      const result = await lifetime.track(
        runVitestShutdownCommand({
          bin: "/bin/bash",
          args: [path.join(checkout, "scripts/update-gateway.sh")],
          cwd: checkout,
          signal,
          env: {
            PATH: `${bin}${path.delimiter}${path.dirname(nodeExecPath)}${path.delimiter}${process.env.PATH ?? ""}`,
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
            LEGACY_FIXTURE_NODE: nodeExecPath,
            LEGACY_FIXTURE_MODE: mode,
            LEGACY_FIXTURE_PROFILE: mode === "explicit-profile" ? "qaRuntime" : "full",
            ...(restart === undefined ? {} : { OPENCLAW_UPDATE_RESTART_CMD: restart }),
          },
        }),
      );
      const read = (file: string) => fs.readFileSync(path.join(checkout, file), "utf8");
      const hasBackups = fs
        .readdirSync(checkout)
        .some((name) => name.startsWith(".update-build-backup."));
      const expectBackups = (present: boolean) => expect(hasBackups).toBe(present);
      const expectRuntime = (backups: boolean) => {
        expect(read("dist/entry.js")).toBe("old runtime\n");
        expectBackups(backups);
      };
      const exists = (file: string) => fs.existsSync(path.join(checkout, file));
      expect(result.code, result.stderr).toBe(code);
      const events = exists("events") ? read("events").trim().split("\n") : [];
      const expectEvents = (sequence: string) =>
        expect(events, result.stderr).toEqual(sequence.split(" "));
      const expectError = (message: string) => expect(result.stderr).toContain(message);
      const build = "stop mutation build";
      const recovered = "enable native-admission native-restart";
      if (["manual", "whitespace", "sibling", "unavailable", "explicit-profile"].includes(mode)) {
        expectError("Refusing to rebuild artifacts");
        expect(events).toEqual([]);
      } else if (mode.startsWith("build-throw-")) {
        expectError("fixture compiler rejected");
        expectBackups(true);
        if (mode === "build-throw-restore") {
          expectError("could not be fully restored");
          expectEvents(`${build} complete:false`);
          expect(fs.lstatSync(path.join(checkout, "dist")).isSymbolicLink()).toBe(true);
          expect(read("foreign/dist/entry.js")).toBe("old runtime\n");
        } else {
          const phase = mode === "build-throw-settle" ? "completion" : "restart";
          expectError(`fixture native ${phase} failed`);
          expectEvents(
            `${build} ${recovered} ` +
              (mode === "build-throw-settle" ? "complete:true" : "complete:false disable"),
          );
          expect(read("dist/entry.js")).toBe("old runtime\n");
        }
      } else if (mode.startsWith("begin-")) {
        expectError("openclaw-update-abort");
        expectRuntime(false);
        if (mode === "begin-abort") {
          expectEvents(`stop mutation ${recovered} complete:true`);
        } else if (mode === "begin-unjoined") {
          expectEvents(
            "stop mutation enable native-admission restart-unjoined complete:false disable",
          );
          expect(exists(".artifacts/dist-artifacts.lock/owner.json")).toBe(true);
        } else {
          expectEvents(`stop mutation complete:${mode !== "begin-lost"}`);
          expectError(`fixture recovery ${mode.slice(6)}`);
        }
      } else if (mode === "native-unjoined") {
        expectEvents("stop");
        expectError("Native source-update cleanup is unverified");
        expect(exists(".artifacts/dist-artifacts.lock/owner.json")).toBe(true);
      } else if (mode.startsWith("partial-stop")) {
        expectEvents(
          "stop native-admission" + (mode === "partial-stop-drift" ? "" : " native-restart"),
        );
        expectError("fixture stop rejected after native mutation");
        if (mode === "partial-stop-drift") {
          expectError("native fingerprint changed");
        } else if (mode === "partial-stop-scheduled") {
          expect(result.stderr).toMatch(/scheduled|not completed/i);
        }
        expectRuntime(false);
      } else if (mode.startsWith("failure-")) {
        expectEvents(
          "stop mutation build enable native-admission " +
            (mode === "failure-scheduled" ? "native-restart " : "") +
            "complete:false disable",
        );
        expectError("Source build failed (exit 17)");
        expectError(
          mode === "failure-drift"
            ? "native fingerprint changed"
            : mode === "failure-revoked"
              ? "fixture recovery revoked"
              : "restart was not completed",
        );
        expect(exists("stopped")).toBe(true);
        expectRuntime(true);
      } else if (mode === "drift" || mode === "unjoined") {
        expectEvents(`${build} complete:false`);
        if (mode === "drift") {
          expectError("native fingerprint changed");
        }
        expectBackups(true);
      } else if (mode === "enable-failure") {
        expectEvents(`${build} enable complete:false disable`);
        expectBackups(true);
      } else {
        const completion =
          mode === "failure" ? `${recovered} complete:true` : "enable complete:true restart";
        expectEvents(owns ? `${build} ${completion}` : "build restart");
        expect(read("dist/entry.js")).toBe(mode === "failure" ? "old runtime\n" : "new runtime\n");
        if (mode === "failure") {
          expect(exists("stopped")).toBe(false);
          expectBackups(false);
        }
        expect(JSON.parse(read("build-env.json"))).toMatchObject({
          npm_execpath: path.join(bin, "pnpm.cjs"),
          workspace: checkout,
        });
      }
    }),
);
