import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const draftId = "11111111-1111-4111-8111-111111111111";

it("uses agent-scoped skills, resolved install records, and the single request draft", () => {
  const workspace = dirs.make("template-inventory-");
  const script = join(workspace, "inventory.mjs");
  copyFileSync(resolve("skills/create-template/scripts/inventory.mjs"), script);
  symlinkSync(resolve("node_modules"), join(workspace, "node_modules"), "junction");
  const path = join(workspace, ".openclaw", "template-drafts", draftId + ".json");
  const portrait = Buffer.from("iVBORw0KGgo=", "base64");
  mkdirSync(join(workspace, "avatars"));
  mkdirSync(join(workspace, ".openclaw", "template-drafts"), { recursive: true });
  writeFileSync(join(workspace, "avatars", "demo.png"), portrait);
  writeFileSync(join(workspace, "IDENTITY.md"), "- **Avatar:** avatars/demo.png\n");
  const cliResults = {
    "agents list": [
      { id: "other", workspace, identityAvatarUrl: "data:image/png;base64,AAAA" },
      {
        id: "demo",
        workspace,
        identityAvatarUrl: "data:image/png;base64," + portrait.toString("base64"),
      },
    ],
    "templates draft": { ok: true, draftId, path },
    "gateway call": {
      agentId: "demo",
      workspaceDir: workspace,
      skills: [
        {
          name: "managed",
          source: "openclaw-managed",
          eligible: true,
          clawhub: { valid: true, slug: "brief", ownerHandle: "vendor", installedVersion: "1.0.2" },
        },
        {
          name: "local",
          source: "openclaw-workspace",
          eligible: true,
          baseDir: join(workspace, "skills", "actual-dir"),
        },
        {
          name: "private",
          source: "openclaw-managed",
          eligible: true,
          blockedByAgentFilter: true,
          clawhub: { valid: true, slug: "hidden", installedVersion: "1.0.0" },
        },
      ],
    },
    "plugins inspect": ["clawhub:DemoAlias@latest", "clawhub:demo"].map((spec, index) => ({
      plugin: {
        id: "adapter" + index,
        origin: "global",
        enabled: true,
        trust: { installSpec: spec },
      },
      install: {
        source: "clawhub",
        spec,
        clawhubPackage: "@vendor/adapter" + index,
        version: "2.1.3",
      },
    })),
    "cron list": { jobs: [] },
    "config get": {},
  };
  writeFileSync(join(workspace, "fixture.json"), JSON.stringify(cliResults));
  writeFileSync(
    join(workspace, "cli.mjs"),
    [
      'import {appendFileSync, readFileSync} from "node:fs";',
      "const args = process.argv.slice(2);",
      'appendFileSync("calls", JSON.stringify(args) + String.fromCharCode(10));',
      'console.log(JSON.stringify(JSON.parse(readFileSync("fixture.json", "utf8"))[args.slice(0, 2).join(" ")]));',
    ].join("\n"),
  );
  const run = (...extra: string[]) =>
    JSON.parse(
      execFileSync(
        resolveTestNodeExecPath(),
        [script, workspace, "--agent", "demo", "--json", ...extra],
        { cwd: workspace, encoding: "utf8" },
      ),
    );
  const ordinary = run();
  expect(ordinary).toMatchObject({
    draftId,
    draftPath: path,
    skills: {
      workspace: [{ name: "local", path: "skills/actual-dir" }],
      clawhub: [{ name: "managed", ref: "@vendor/brief", version: "1.0.2" }],
    },
    plugins: {
      clawhub: [0, 1].map((i) => ({
        id: "adapter" + i,
        ref: "@vendor/adapter" + i,
        version: "2.1.3",
      })),
      notPortable: 0,
    },
  });
  expect(ordinary.avatar).toEqual(expect.any(String));
  expect(readFileSync(join(workspace, ordinary.avatar))).toEqual(portrait);
  expect(ordinary.warnings).toBeUndefined();
  expect(run("--draft", draftId)).toEqual(ordinary);
  const calls = readFileSync(join(workspace, "calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.filter(([family]) => family === "templates")).toEqual([
    ["templates", "draft", workspace, "--json"],
  ]);
  expect(calls).toContainEqual([
    "gateway",
    "call",
    "skills.status",
    "--params",
    JSON.stringify({ agentId: "demo" }),
    "--json",
  ]);
  expect(calls).toContainEqual(["cron", "list", "--agent", "demo", "--json"]);
});
