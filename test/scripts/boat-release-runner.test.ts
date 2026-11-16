import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";

const linuxRunnerTest = it.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(mode = "") {
  const root = mkdtempSync(join(tmpdir(), "boat-runner-test-"));
  roots.push(root);
  const binary = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.RUNNER_TEMP;
const value = (name) => args[args.indexOf(name) + 1];
const statePath = path.join(root, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : {};
fs.appendFileSync(path.join(root, "calls"), JSON.stringify(args) + "\\n");
if (args.includes("--help")) { console.log("  -receipt string"); process.exit(0); }
if (args[0] === "warmup") {
  fs.writeFileSync(statePath, JSON.stringify({leaseID: value("--lease-id"), createdAt: new Date().toISOString()}));
  process.exit(process.env.FIXTURE_MODE === "warmup-failed" ? 1 : 0);
}
if (args[0] === "inspect") console.log(JSON.stringify({id: state.leaseID, serverId: "bx_owned", labels: {ascii_box_created_at: state.createdAt, private: "fixture-secret"}, sshKey: "fixture-private-key", expiresAt: new Date(Date.now() + (process.env.FIXTURE_MODE === "short-ttl" ? 3600000 : 86400000)).toISOString()}));
if (args[0] === "actions" && args[1] === "register") {
  fs.writeFileSync(value("--receipt"), JSON.stringify({version: 1, leaseID: value("--id"), scope: "orgs/example", runnerID: 43, name: value("--name")}));
  if (process.env.FIXTURE_MODE === "register-failed") {
    console.error("fixture-secret fixture-private-key");
    process.exit(23);
  }
}
if (args[0] === "actions" && args[1] === "unregister" && process.env.FIXTURE_MODE === "unregister-failed") process.exit(1);
if (args.includes("info")) console.log(JSON.stringify({sandbox: {id: "bx_owned", createdAt: process.env.FIXTURE_MODE === "changed-vm" ? "2000-01-01T00:00:00Z" : state.createdAt}}));
const operation = {id: "bdop_" + "a".repeat(32), kind: "sandbox", targetId: "bx_owned", status: "completed", completedAt: new Date().toISOString()};
if (args.includes("delete")) {
  if (process.env.FIXTURE_MODE.startsWith("delete-")) operation.status = "pending";
  console.log(JSON.stringify({operation}));
}
if (args.includes("deletion")) {
  if (process.env.FIXTURE_MODE === "delete-failed") operation.status = "failed";
  if (process.env.FIXTURE_MODE === "delete-mismatch") operation.id = "bdop_" + "b".repeat(32);
  console.log(JSON.stringify({operation}));
}
`;
  for (const name of ["crabbox", "boat"]) {
    writeFileSync(join(root, name), binary, { mode: 0o755 });
  }
  const output = join(root, "output");
  writeFileSync(output, "");
  const env = {
    PATH: `${root}:${process.env.PATH}`,
    HOME: root,
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "example/project",
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/release.yml@refs/heads/main",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    BOAT_API_KEY: "fixture-secret",
    BOAT_ORG: "fixture-org",
    BOAT_RUNNER_GROUP: "release",
    FIXTURE_MODE: mode,
  };
  const run = (command: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [resolve("scripts/boat-release-runner.mjs"), command, "decision"], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const value = (name: "vm" | "runner" | "label") =>
    expectDefined(
      Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )[name],
      `Missing ${name} workflow output`,
    );
  const calls = () =>
    readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
  return { run, value, calls };
}

linuxRunnerTest("publishes only public identities and cleans up both resources", () => {
  const f = fixture();
  expect(f.run("provision").status).toBe(0);
  const vm = f.value("vm");
  expect(Object.keys(JSON.parse(vm)).toSorted()).toEqual(["createdAt", "id", "leaseID"]);
  expect(vm).not.toMatch(/fixture-secret|fixture-private-key/);
  expect(f.run("register", { BOAT_VM_RECEIPT: vm }).status).toBe(0);
  expect(f.value("label")).toBe(JSON.parse(f.value("runner")).name);
  for (const call of f
    .calls()
    .filter(
      (args) => args[0] === "warmup" || (args[1] === "register" && !args.includes("--help")),
    )) {
    expect(call).toEqual(
      expect.arrayContaining(["--ascii-box-no-env", "--ascii-box-no-snapshots"]),
    );
    expect(
      call.slice(
        call.indexOf("--ascii-box-visibility"),
        call.indexOf("--ascii-box-visibility") + 2,
      ),
    ).toEqual(["--ascii-box-visibility", "private"]);
  }
  expect(
    f.run("cleanup", { BOAT_VM_RECEIPT: vm, BOAT_RUNNER_RECEIPT: f.value("runner") }).status,
  ).toBe(0);
  expect(f.calls().filter((args) => args.includes("delete"))).toHaveLength(1);
  expect(f.calls().filter((args) => args[1] === "unregister")).toHaveLength(1);
});

linuxRunnerTest.each(["short-ttl", "warmup-failed"])(
  "retains cleanup identity after %s",
  (mode) => {
    const f = fixture(mode);
    expect(f.run("provision").status).not.toBe(0);
    expect(JSON.parse(f.value("vm")).id).toBe("bx_owned");
    expect(f.calls().some((args) => args[1] === "register" && !args.includes("--help"))).toBe(
      false,
    );
  },
);

linuxRunnerTest("reports safe registration errors and retains cleanup receipts", () => {
  const f = fixture("register-failed");
  expect(f.run("provision").status).toBe(0);
  const result = f.run("register", { BOAT_VM_RECEIPT: f.value("vm") });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Boat runner registration failed (23)");
  expect(`${result.stdout}${result.stderr}`).not.toMatch(/fixture-secret|fixture-private-key/);
  expect(JSON.parse(f.value("runner")).runnerID).toBe(43);
});

linuxRunnerTest("deletes the VM even when deregistration fails", () => {
  const f = fixture();
  expect(f.run("provision").status).toBe(0);
  const vm = f.value("vm");
  expect(f.run("register", { BOAT_VM_RECEIPT: vm }).status).toBe(0);
  expect(
    f.run("cleanup", {
      BOAT_VM_RECEIPT: vm,
      BOAT_RUNNER_RECEIPT: f.value("runner"),
      FIXTURE_MODE: "unregister-failed",
    }).status,
  ).not.toBe(0);
  expect(f.calls().filter((args) => args.includes("delete"))).toHaveLength(1);
});

linuxRunnerTest("refuses to delete a VM whose creation identity changed", () => {
  const f = fixture();
  expect(f.run("provision").status).toBe(0);
  expect(
    f.run("cleanup", { BOAT_VM_RECEIPT: f.value("vm"), FIXTURE_MODE: "changed-vm" }).status,
  ).not.toBe(0);
  expect(f.calls().some((args) => args.includes("delete"))).toBe(false);
});

linuxRunnerTest.each([
  { mode: "delete-pending", status: 0 },
  { mode: "delete-failed", status: 1 },
  { mode: "delete-mismatch", status: 1 },
])("settles asynchronous deletion: $mode", ({ mode, status }) => {
  const f = fixture(mode);
  expect(f.run("provision").status).toBe(0);
  expect(f.run("cleanup", { BOAT_VM_RECEIPT: f.value("vm") }).status).toBe(status);
  expect(f.calls().filter((args) => args.includes("delete"))).toHaveLength(1);
  expect(f.calls().filter((args) => args.includes("deletion"))).toEqual([
    ["--no-update", "--json", "deletion", "status", "bdop_" + "a".repeat(32)],
  ]);
});
